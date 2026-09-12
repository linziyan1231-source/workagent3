package collaboration

import (
	"context"
)

// ChannelHistory pages through visible speech, excluding status/audit messages.
// A changed head restarts pagination at the latest message.
func (s *Store) ChannelHistory(ctx context.Context, id string, userID, head, before int64, limit int) ([]Message, int64, error) {
	if _, err := s.ConversationForUser(ctx, id, userID, true); err != nil {
		return nil, 0, err
	}
	var latest int64
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq),0) FROM shared_messages WHERE conversation_id=? AND kind IN ('user','assistant')`, id).Scan(&latest); err != nil {
		return nil, 0, err
	}
	if head != latest || before <= 0 {
		before = latest + 1
	}
	rows, err := s.listMessages(ctx, `m.seq IN (SELECT seq FROM shared_messages WHERE conversation_id=? AND kind IN ('user','assistant') AND seq<? ORDER BY seq DESC LIMIT ?)`, []any{id, before, limit, limit})
	return rows, latest, err
}

func (s *Store) ChannelHead(ctx context.Context) (int64, error) {
	var seq int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq),0) FROM shared_messages`).Scan(&seq)
	return seq, err
}
