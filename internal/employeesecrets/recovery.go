package employeesecrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"golang.org/x/crypto/scrypt"
)

// Recovery envelopes are independent of machine DPAPI. The recovery passphrase
// is supplied over stdin by an operator and stored separately from the backup.
func (v *Vault) Export(id string, passphrase []byte) ([]byte, error) {
	if len(passphrase) < 24 {
		return nil, errors.New("recovery passphrase must contain at least 24 bytes")
	}
	record, err := v.Read(id)
	if err != nil {
		return nil, err
	}
	defer record.Clear()
	plain, _ := json.Marshal(record)
	defer clear(plain)
	salt := make([]byte, 16)
	rand.Read(salt)
	aead, err := recoveryCipher(passphrase, salt)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	rand.Read(nonce)
	header := append([]byte("WA3REC01"), salt...)
	header = append(header, nonce...)
	return aead.Seal(header, nonce, plain, header[:24]), nil
}
func (v *Vault) Import(id string, passphrase, data []byte) error {
	if len(data) < 52 || string(data[:8]) != "WA3REC01" {
		return errors.New("invalid recovery envelope")
	}
	aead, err := recoveryCipher(passphrase, data[8:24])
	if err != nil {
		return err
	}
	plain, err := aead.Open(nil, data[24:36], data[36:], data[:24])
	if err != nil {
		return errors.New("recovery passphrase or envelope is invalid")
	}
	defer clear(plain)
	var r Record
	if err := json.Unmarshal(plain, &r); err != nil {
		return err
	}
	defer r.Clear()
	if r.SID != id {
		return errors.New("recovery envelope SID mismatch")
	}
	return v.Write(id, r)
}
func recoveryCipher(pass, salt []byte) (cipher.AEAD, error) {
	key, err := scrypt.Key(pass, salt, 32768, 8, 1, 32)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
