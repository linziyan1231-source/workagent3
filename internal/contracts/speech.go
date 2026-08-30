package contracts

type SpeechCapability struct {
	Enabled            bool   `json:"enabled"`
	Streaming          bool   `json:"streaming"`
	MaxAudioBytes      int64  `json:"maxAudioBytes"`
	MaxStreamSeconds   int64  `json:"maxStreamSeconds"`
	AcceptedFormatHint string `json:"acceptedFormatHint"`
}
