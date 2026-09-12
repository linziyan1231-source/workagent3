package collaboration

import (
	"fmt"
	"testing"
)

func TestChannelHistoryPagesSpeechAndResetsOnNewMessage(t *testing.T) {
	s := openTestStore(t)
	p := createActiveProject(t, s)
	c, err := s.CreateConversation(t.Context(), Conversation{ID: "conversation_channel1", ProjectID: p.ID, Name: "Discussion"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 6; i++ {
		kind := "user"
		if i%2 == 0 {
			kind = "assistant"
		}
		if i == 3 {
			kind = "system"
		}
		if _, err := s.db.Exec(`INSERT INTO shared_messages(id,conversation_id,author_name,kind,body,created_at) VALUES(?,?,?,?,?,?)`, fmt.Sprintf("message_channel_%02d", i), c.ID, "Author", kind, fmt.Sprint(i), i); err != nil {
			t.Fatal(err)
		}
	}
	a, head, err := s.ChannelHistory(t.Context(), c.ID, 1, 0, 0, 2)
	if err != nil || len(a) != 2 || a[0].Body != "5" || a[1].Body != "6" {
		t.Fatalf("latest %#v %v", a, err)
	}
	b, _, err := s.ChannelHistory(t.Context(), c.ID, 1, head, a[0].Seq, 2)
	if err != nil || len(b) != 2 || b[0].Body != "2" || b[1].Body != "4" {
		t.Fatalf("older %#v %v", b, err)
	}
	last, _, _ := s.ChannelHistory(t.Context(), c.ID, 1, head, b[0].Seq, 2)
	empty, _, _ := s.ChannelHistory(t.Context(), c.ID, 1, head, last[0].Seq, 2)
	if len(empty) != 0 {
		t.Fatal("history wrapped")
	}
	if _, _, err := s.ChannelHistory(t.Context(), c.ID, 99, 0, 0, 2); err == nil {
		t.Fatal("nonmember history allowed")
	}
	_, err = s.AddMessage(t.Context(), Message{ID: "message_channel_new", Conversation: c.ID, AuthorName: "Owner", Kind: "user", Body: "new"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	reset, newHead, err := s.ChannelHistory(t.Context(), c.ID, 1, head, b[0].Seq, 2)
	if err != nil || newHead == head || len(reset) != 2 || reset[1].Body != "new" {
		t.Fatalf("reset %#v %v", reset, err)
	}
}
