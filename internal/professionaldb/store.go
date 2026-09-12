// Package professionaldb owns professional database access, per-employee quotas,
// and the remote MCP adapter. It has no dependency on a previous deployment.
package professionaldb

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/credentialbroker"

	_ "modernc.org/sqlite"
)

type Grant = contracts.KimiDatasourceGrant

var Sources = []string{
	"stock_finance_data", "yahoo_finance", "world_bank_open_data", "tianyancha",
	"arxiv", "scholar", "yuandian_law", "wind", "imf", "gildata", "sec_edgar", "sp_data",
	"china_nda", "china_nbs", "china_standards", "who", "fao", "unsd", "ecb", "eurostat",
	"unicef", "oecd", "fred", "xhcj", "caixin",
}

var (
	ErrUnauthorized     = errors.New("PROFESSIONAL_DATABASE_UNAUTHORIZED：请重新安装专业数据库以更新授权")
	ErrDisabled         = errors.New("PROFESSIONAL_DATABASE_DISABLED：管理员尚未开放专业数据库权限")
	ErrSourceDenied     = errors.New("PROFESSIONAL_DATABASE_SOURCE_DENIED：当前用户无权使用此数据源")
	ErrDailyExceeded    = errors.New("PROFESSIONAL_DATABASE_DAILY_QUOTA_EXCEEDED：今日调用次数已用完")
	ErrMonthlyExceeded  = errors.New("PROFESSIONAL_DATABASE_MONTHLY_QUOTA_EXCEEDED：本月调用次数已用完")
	ErrInvalidArguments = errors.New("PROFESSIONAL_DATABASE_INVALID_ARGUMENTS：请检查数据源、接口名称及参数")
	ErrNeedsAuth        = errors.New("PROFESSIONAL_DATABASE_NEEDS_AUTH：专业数据库上游授权待管理员配置或重新登录")
	ErrUpstream         = errors.New("PROFESSIONAL_DATABASE_UPSTREAM_ERROR：上游查询失败，本次已计入调用次数")
)

// Quotas follow the product's China calendar independently of the server zone.
var quotaZone = time.FixedZone("Asia/Shanghai", 8*60*60)

type Store struct {
	db        *sql.DB
	protector credentialbroker.Protector
	now       func() time.Time
}

func Open(path string, protector credentialbroker.Protector) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open professional database store: %w", err)
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db, protector: protector, now: time.Now}
	_, err = db.Exec(`
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS professional_database_grants (
 sid TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
 sources TEXT NOT NULL DEFAULT '[]', daily_limit INTEGER NOT NULL DEFAULT 0,
 monthly_limit INTEGER NOT NULL DEFAULT 0, sealed_token BLOB,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS professional_database_usage (
 sid TEXT NOT NULL, period TEXT NOT NULL, period_key TEXT NOT NULL,
 used INTEGER NOT NULL, PRIMARY KEY(sid,period,period_key)
);
CREATE TABLE IF NOT EXISTS professional_database_calls (
 id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, source TEXT NOT NULL,
 method TEXT NOT NULL, reserved_at INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT 'reserved'
);`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize professional database store: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func normalizeGrant(grant Grant) (Grant, error) {
	if grant.DailyLimit < 0 || grant.DailyLimit > 10000 || grant.MonthlyLimit < grant.DailyLimit || grant.MonthlyLimit > 100000 {
		return Grant{}, errors.New("专业数据库每日限额须为 0–10000，每月限额须不小于每日限额且不超过 100000；0 表示不允许调用")
	}
	seen := make(map[string]bool)
	for _, value := range grant.AllowedSources {
		value = strings.ToLower(strings.TrimSpace(value))
		if !slices.Contains(Sources, value) {
			return Grant{}, errors.New("专业数据库包含未知数据源")
		}
		seen[value] = true
	}
	grant.AllowedSources = make([]string, 0, len(seen))
	for _, value := range Sources {
		if seen[value] {
			grant.AllowedSources = append(grant.AllowedSources, value)
		}
	}
	if grant.Enabled && len(grant.AllowedSources) == 0 {
		return Grant{}, errors.New("启用专业数据库时至少选择一个数据源")
	}
	return grant, nil
}

func validSID(sid string) bool {
	return sid != "" && len(sid) <= 184 && !strings.ContainsAny(sid, ". \t\r\n")
}

// SetGrant never resets usage. Client-supplied usage fields are ignored.
func (s *Store) SetGrant(ctx context.Context, sid string, grant Grant) (Grant, error) {
	if !validSID(sid) {
		return Grant{}, errors.New("专业数据库授权缺少有效的员工标识")
	}
	grant, err := normalizeGrant(grant)
	if err != nil {
		return Grant{}, err
	}
	sources, _ := json.Marshal(grant.AllowedSources)
	_, err = s.db.ExecContext(ctx, `INSERT INTO professional_database_grants(sid,enabled,sources,daily_limit,monthly_limit,updated_at)
VALUES(?,?,?,?,?,?) ON CONFLICT(sid) DO UPDATE SET enabled=excluded.enabled,sources=excluded.sources,
daily_limit=excluded.daily_limit,monthly_limit=excluded.monthly_limit,updated_at=excluded.updated_at`,
		sid, grant.Enabled, string(sources), grant.DailyLimit, grant.MonthlyLimit, s.now().Unix())
	if err != nil {
		return Grant{}, err
	}
	return s.Grant(ctx, sid)
}

type querier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readGrant(ctx context.Context, db querier, sid string, now time.Time) (Grant, []byte, error) {
	var grant Grant
	var encoded string
	var sealed []byte
	err := db.QueryRowContext(ctx, `SELECT enabled,sources,daily_limit,monthly_limit,sealed_token,
COALESCE((SELECT used FROM professional_database_usage WHERE sid=g.sid AND period='day' AND period_key=?),0),
COALESCE((SELECT used FROM professional_database_usage WHERE sid=g.sid AND period='month' AND period_key=?),0)
FROM professional_database_grants g WHERE sid=?`, dayKey(now), monthKey(now), sid).Scan(
		&grant.Enabled, &encoded, &grant.DailyLimit, &grant.MonthlyLimit, &sealed, &grant.DailyUsed, &grant.MonthlyUsed)
	if err != nil {
		return Grant{}, nil, err
	}
	if err := json.Unmarshal([]byte(encoded), &grant.AllowedSources); err != nil {
		return Grant{}, nil, err
	}
	return grant, sealed, nil
}

func (s *Store) Grant(ctx context.Context, sid string) (Grant, error) {
	grant, _, err := readGrant(ctx, s.db, sid, s.now())
	if errors.Is(err, sql.ErrNoRows) {
		return Grant{AllowedSources: []string{}}, nil
	}
	return grant, err
}

// IssueToken returns a stable, independently encrypted token for this employee.
func (s *Store) IssueToken(ctx context.Context, sid string) (string, error) {
	if !validSID(sid) {
		return "", ErrUnauthorized
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	_, sealed, err := readGrant(ctx, tx, sid, s.now())
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrDisabled
	}
	if err != nil {
		return "", err
	}
	if len(sealed) > 0 {
		plain, err := s.protector.Open(sealed)
		if err != nil {
			return "", errors.New("无法读取专业数据库授权")
		}
		defer clear(plain)
		return sid + "." + string(plain), nil
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	secret := base64.RawURLEncoding.EncodeToString(random)
	clear(random)
	sealed, err = s.protector.Seal([]byte(secret))
	if err != nil {
		return "", errors.New("无法保护专业数据库授权")
	}
	if _, err = tx.ExecContext(ctx, `UPDATE professional_database_grants SET sealed_token=? WHERE sid=?`, sealed, sid); err != nil {
		return "", err
	}
	if err = tx.Commit(); err != nil {
		return "", err
	}
	return sid + "." + secret, nil
}

func (s *Store) authenticate(ctx context.Context, db querier, token string, now time.Time) (Grant, string, error) {
	sid, supplied, ok := strings.Cut(token, ".")
	if !ok || !validSID(sid) || len(supplied) != 43 {
		return Grant{}, "", ErrUnauthorized
	}
	grant, sealed, err := readGrant(ctx, db, sid, now)
	if errors.Is(err, sql.ErrNoRows) {
		return Grant{}, "", ErrUnauthorized
	}
	if err != nil {
		return Grant{}, "", err
	}
	if len(sealed) == 0 {
		return Grant{}, "", ErrUnauthorized
	}
	plain, err := s.protector.Open(sealed)
	if err != nil {
		return Grant{}, "", ErrUnauthorized
	}
	defer clear(plain)
	if subtle.ConstantTimeCompare(plain, []byte(supplied)) != 1 {
		return Grant{}, "", ErrUnauthorized
	}
	if !grant.Enabled {
		return Grant{}, "", ErrDisabled
	}
	return grant, sid, nil
}

// reserve authorizes again inside the same transaction as both quota updates.
// Reservations survive restarts and dispatched failures; they are never refunded.
func (s *Store) reserve(ctx context.Context, token, source, method string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	now := s.now()
	grant, sid, err := s.authenticate(ctx, tx, token, now)
	if err != nil {
		return 0, err
	}
	if !slices.Contains(grant.AllowedSources, source) {
		return 0, ErrSourceDenied
	}
	if grant.DailyUsed >= grant.DailyLimit {
		return 0, ErrDailyExceeded
	}
	if grant.MonthlyUsed >= grant.MonthlyLimit {
		return 0, ErrMonthlyExceeded
	}
	for _, period := range []struct{ kind, key string }{{"day", dayKey(now)}, {"month", monthKey(now)}} {
		_, err = tx.ExecContext(ctx, `INSERT INTO professional_database_usage(sid,period,period_key,used) VALUES(?,?,?,1)
ON CONFLICT(sid,period,period_key) DO UPDATE SET used=used+1`, sid, period.kind, period.key)
		if err != nil {
			return 0, err
		}
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO professional_database_calls(sid,source,method,reserved_at) VALUES(?,?,?,?)`, sid, source, method, now.Unix())
	if err != nil {
		return 0, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

func (s *Store) finish(id int64, outcome string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// A failed audit update leaves "reserved", conservatively retaining the charge.
	_, _ = s.db.ExecContext(ctx, `UPDATE professional_database_calls SET outcome=? WHERE id=?`, outcome, id)
}

func dayKey(now time.Time) string   { return now.In(quotaZone).Format("2006-01-02") }
func monthKey(now time.Time) string { return now.In(quotaZone).Format("2006-01") }
