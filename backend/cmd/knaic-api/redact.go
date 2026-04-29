package main

import "net/url"

// redactDSN returns the DSN with the password obscured so it's safe to log.
// Falls back to the original string if the input doesn't parse as a URL —
// e.g. libpq key/value style "host=... password=..." which is best-effort
// scrubbed by replacing the password=... segment.
func redactDSN(dsn string) string {
	if u, err := url.Parse(dsn); err == nil && u.User != nil {
		if _, ok := u.User.Password(); ok {
			u.User = url.UserPassword(u.User.Username(), "redacted")
		}
		return u.String()
	}
	return dsn
}
