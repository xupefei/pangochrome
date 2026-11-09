package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// Chrome rejects messages from a native host that are larger than 1 MiB.
const maxMessageSize = 1 << 20

// readMessage reads one native-messaging frame: a 4-byte little-endian
// length, then that many bytes of JSON.
func readMessage(r io.Reader) ([]byte, error) {
	var n uint32
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		return nil, err
	}
	if n > maxMessageSize {
		return nil, fmt.Errorf("message of %d bytes is over the 1 MiB limit", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// msgWriter writes native-messaging frames. It is safe for concurrent use.
type msgWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (m *msgWriter) send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b) > maxMessageSize {
		return errors.New("message is over the 1 MiB limit")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := binary.Write(m.w, binary.LittleEndian, uint32(len(b))); err != nil {
		return err
	}
	_, err = m.w.Write(b)
	return err
}
