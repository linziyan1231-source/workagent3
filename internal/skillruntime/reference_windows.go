//go:build windows

package skillruntime

import (
	"encoding/base64"
	"encoding/binary"
	"os/exec"
	"strings"
	"syscall"
	"unicode/utf16"
)

func createDirectoryReference(link, target string) error {
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	script := "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path " + quote(link) + " -Target " + quote(target) + " | Out-Null"
	units := utf16.Encode([]rune(script))
	payload := make([]byte, len(units)*2)
	for index, unit := range units {
		binary.LittleEndian.PutUint16(payload[index*2:], unit)
	}
	command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(payload))
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return command.Run()
}
