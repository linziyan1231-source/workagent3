//go:build windows

package winutil

import (
	"bytes"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"runtime"
	"sync"
	"unsafe"
)

var networkRulesMu sync.Mutex
var fwpuclnt = windows.NewLazySystemDLL("fwpuclnt.dll")
var firewallAPI = windows.NewLazySystemDLL("FirewallAPI.dll")
var appSublayer = mustAppGUID("{96b1407c-ab46-41e0-8374-9a3978d63ff2}")
var packageCondition = mustAppGUID("{71bc78fa-f17c-4997-a602-6abb261f351c}")
var remoteAddressCondition = mustAppGUID("{b235ae9a-1d64-49b8-a44c-5ff3d9095045}")
var localAddressCondition = mustAppGUID("{d9ee00de-c1ef-4617-bfe3-ffd8f5a08957}")
var remotePortCondition = mustAppGUID("{c35a604d-d22b-4e1a-91b4-68f674ee674b}")
var localPortCondition = mustAppGUID("{0c1ba1af-5765-453f-af22-a8f791ac775b}")
var protocolCondition = mustAppGUID("{3971ef2b-623e-4f9a-8cb1-6e79b806b9a7}")

func mustAppGUID(value string) windows.GUID {
	v, err := windows.GUIDFromString(value)
	if err != nil {
		panic(err)
	}
	return v
}

type appFWBlob struct {
	Size uint32
	Data *byte
}
type appFWDisplay struct {
	Name        *uint16
	Description *uint16
}
type appFWValue struct {
	Type  uint32
	Value uintptr
}
type appFWCondition struct {
	Field windows.GUID
	Match uint32
	Value appFWValue
}
type appFWAction struct {
	Type uint32
	Key  windows.GUID
}
type appFWFilter struct {
	Key             windows.GUID
	Display         appFWDisplay
	Flags           uint32
	Provider        *windows.GUID
	Data            appFWBlob
	Layer           windows.GUID
	Sublayer        windows.GUID
	Weight          appFWValue
	Count           uint32
	Conditions      *appFWCondition
	Action          appFWAction
	Context         [2]uint64
	Reserved        *windows.GUID
	ID              uint64
	EffectiveWeight appFWValue
}
type appFWSubLayer struct {
	Key      windows.GUID
	Display  appFWDisplay
	Flags    uint32
	Provider *windows.GUID
	Data     appFWBlob
	Weight   uint16
}

func appFWCall(name string, args ...uintptr) error {
	result, _, _ := fwpuclnt.NewProc(name).Call(args...)
	if result != 0 {
		return fmt.Errorf("%s: 0x%x", name, result)
	}
	return nil
}

// EnableAppNetwork must run in the privileged Portal. The caller authenticates
// the owning runtime and version. The only permitted traffic is TCP to this
// app's HTTP broker and TCP accepted on this app's backend loopback port.
// Persistent deny filters are committed before loopback exemption is enabled.
func EnableAppNetwork(rule AppNetworkRule) (string, error) {
	if rule.BackendPort < 1024 || rule.BackendPort > 65535 || rule.BrokerPort < 1024 || rule.BrokerPort > 65535 || rule.BackendPort == rule.BrokerPort {
		return "", errors.New("invalid application network ports")
	}
	identity, err := DerivedAppContainerSID(rule.AppID, rule.Version)
	if err != nil {
		return "", err
	}
	sid, err := windows.StringToSid(identity)
	if err != nil {
		return "", err
	}
	networkRulesMu.Lock()
	defer networkRulesMu.Unlock()
	var engine windows.Handle
	if err = appFWCall("FwpmEngineOpen0", 0, 10, 0, 0, uintptr(unsafe.Pointer(&engine))); err != nil {
		return "", err
	}
	defer appFWCall("FwpmEngineClose0", uintptr(engine))
	sublayer := appFWSubLayer{Key: appSublayer, Display: appFWDisplay{Name: windows.StringToUTF16Ptr("WorkAgent published applications")}, Flags: 1, Weight: 0xfff0}
	result, _, _ := fwpuclnt.NewProc("FwpmSubLayerAdd0").Call(uintptr(engine), uintptr(unsafe.Pointer(&sublayer)), 0)
	if result != 0 && uint32(result) != 0x80320009 {
		return "", fmt.Errorf("create application firewall sublayer: 0x%x", result)
	}
	if err = appFWCall("FwpmTransactionBegin0", uintptr(engine), 0); err != nil {
		return "", err
	}
	committed := false
	defer func() {
		if !committed {
			_ = appFWCall("FwpmTransactionAbort0", uintptr(engine))
		}
	}()
	if err = removeAppFilters(engine, identity); err != nil {
		return "", err
	}
	packageMatch := appFWCondition{Field: packageCondition, Value: appFWValue{Type: 13, Value: uintptr(unsafe.Pointer(sid))}}
	layers := []string{"{c38d57d1-05a7-4c33-904f-7fbceee60e82}", "{4a72393b-319f-44bc-84c3-ba54dcb3b6b4}", "{e1cd9fe7-f4b5-4273-96c0-592e487b8650}", "{a3b42c97-9f04-4672-b87e-cee9c483257f}"}
	for index, raw := range layers {
		layer := mustAppGUID(raw)
		if err = addAppFilter(engine, identity, layer, []appFWCondition{packageMatch}, false); err != nil {
			return "", err
		}
		if index%2 == 1 {
			continue
		} // No IPv6 exceptions, including ::1.
		conditions := []appFWCondition{packageMatch, {Field: protocolCondition, Value: appFWValue{Type: 1, Value: 6}}, {Field: remoteAddressCondition, Value: appFWValue{Type: 3, Value: 0x7f000001}}}
		if index == 0 {
			conditions = append(conditions, appFWCondition{Field: remotePortCondition, Value: appFWValue{Type: 2, Value: uintptr(rule.BrokerPort)}})
		} else {
			conditions = append(conditions, appFWCondition{Field: localAddressCondition, Value: appFWValue{Type: 3, Value: 0x7f000001}}, appFWCondition{Field: localPortCondition, Value: appFWValue{Type: 2, Value: uintptr(rule.BackendPort)}})
		}
		if err = addAppFilter(engine, identity, layer, conditions, true); err != nil {
			return "", err
		}
	}
	if err = appFWCall("FwpmTransactionCommit0", uintptr(engine)); err != nil {
		return "", err
	}
	committed = true
	runtime.KeepAlive(sid)
	if err = enableAppLoopback(sid); err != nil {
		return "", err
	}
	return identity, nil
}

func addAppFilter(engine windows.Handle, identity string, layer windows.GUID, conditions []appFWCondition, allow bool) error {
	data := []byte(identity)
	action, weight := uint32(0x1001), uintptr(1)
	if allow {
		action = 0x1002
		weight = 15
	}
	filter := appFWFilter{Display: appFWDisplay{Name: windows.StringToUTF16Ptr("WorkAgent application network boundary")}, Flags: 1, Data: appFWBlob{Size: uint32(len(data)), Data: &data[0]}, Layer: layer, Sublayer: appSublayer, Weight: appFWValue{Type: 1, Value: weight}, Count: uint32(len(conditions)), Conditions: &conditions[0], Action: appFWAction{Type: action}}
	// A hard permit for these exact loopback endpoints overrides Windows' lower
	// AppContainer inbound loopback block. All other traffic hits our deny.
	if allow {
		filter.Flags |= 8
	}
	err := appFWCall("FwpmFilterAdd0", uintptr(engine), uintptr(unsafe.Pointer(&filter)), 0, 0)
	runtime.KeepAlive(data)
	runtime.KeepAlive(conditions)
	return err
}
func removeAppFilters(engine windows.Handle, identity string) error {
	var enumeration windows.Handle
	if err := appFWCall("FwpmFilterCreateEnumHandle0", uintptr(engine), 0, uintptr(unsafe.Pointer(&enumeration))); err != nil {
		return err
	}
	defer appFWCall("FwpmFilterDestroyEnumHandle0", uintptr(engine), uintptr(enumeration))
	for {
		var items **appFWFilter
		var count uint32
		if err := appFWCall("FwpmFilterEnum0", uintptr(engine), uintptr(enumeration), 128, uintptr(unsafe.Pointer(&items)), uintptr(unsafe.Pointer(&count))); err != nil {
			return err
		}
		ids := []uint64{}
		for _, item := range unsafe.Slice(items, count) {
			if item.Sublayer == appSublayer && item.Data.Size == uint32(len(identity)) && bytes.Equal(unsafe.Slice(item.Data.Data, item.Data.Size), []byte(identity)) {
				ids = append(ids, item.ID)
			}
		}
		_ = appFWCall("FwpmFreeMemory0", uintptr(unsafe.Pointer(&items)))
		for _, id := range ids {
			if err := appFWCall("FwpmFilterDeleteById0", uintptr(engine), uintptr(id)); err != nil {
				return err
			}
		}
		if count < 128 {
			return nil
		}
	}
}
func enableAppLoopback(sid *windows.SID) error {
	var count uint32
	var items *windows.SIDAndAttributes
	result, _, _ := firewallAPI.NewProc("NetworkIsolationGetAppContainerConfig").Call(uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&items)))
	if result != 0 {
		return fmt.Errorf("read application loopback configuration: %d", result)
	}
	if items != nil {
		defer windows.LocalFree(windows.Handle(unsafe.Pointer(items)))
	}
	entries := append([]windows.SIDAndAttributes{}, unsafe.Slice(items, count)...)
	for _, item := range entries {
		if item.Sid.Equals(sid) {
			return nil
		}
	}
	entries = append(entries, windows.SIDAndAttributes{Sid: sid, Attributes: windows.SE_GROUP_ENABLED})
	result, _, _ = firewallAPI.NewProc("NetworkIsolationSetAppContainerConfig").Call(uintptr(len(entries)), uintptr(unsafe.Pointer(&entries[0])))
	runtime.KeepAlive(entries)
	if result != 0 {
		return fmt.Errorf("set application loopback configuration: %d", result)
	}
	return nil
}

// DisableAppNetwork is used only after the application Job has been stopped.
func DisableAppNetwork(rule AppNetworkRule) error {
	identity, err := DerivedAppContainerSID(rule.AppID, rule.Version)
	if err != nil {
		return err
	}
	networkRulesMu.Lock()
	defer networkRulesMu.Unlock()
	var count uint32
	var items *windows.SIDAndAttributes
	result, _, _ := firewallAPI.NewProc("NetworkIsolationGetAppContainerConfig").Call(uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&items)))
	if result != 0 {
		return fmt.Errorf("read loopback configuration: %d", result)
	}
	if items != nil {
		defer windows.LocalFree(windows.Handle(unsafe.Pointer(items)))
	}
	kept := []windows.SIDAndAttributes{}
	for _, item := range unsafe.Slice(items, count) {
		if item.Sid.String() != identity {
			kept = append(kept, item)
		}
	}
	var first uintptr
	if len(kept) > 0 {
		first = uintptr(unsafe.Pointer(&kept[0]))
	}
	result, _, _ = firewallAPI.NewProc("NetworkIsolationSetAppContainerConfig").Call(uintptr(len(kept)), first)
	runtime.KeepAlive(kept)
	if result != 0 {
		return fmt.Errorf("disable app loopback: %d", result)
	}
	var engine windows.Handle
	if err = appFWCall("FwpmEngineOpen0", 0, 10, 0, 0, uintptr(unsafe.Pointer(&engine))); err != nil {
		return err
	}
	defer appFWCall("FwpmEngineClose0", uintptr(engine))
	return removeAppFilters(engine, identity)
}
