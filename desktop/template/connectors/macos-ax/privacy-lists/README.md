# macOS AX Privacy Lists

These lists are connector-owned data packs for privacy classification. They do
not define activity semantics and they should not be copied into
Source config. User choices and overrides live in Source config;
these files are only the built-in baseline.

The runtime loads the files once at connector startup and performs in-memory
suffix lookup against eligible surface domains:

```text
secure.chase.com -> secure.chase.com -> chase.com
```

The output of classification must be recorded in `privacyDecision` so later
pipelines can explain why rich context was kept, downgraded to metadata-only, or
disabled.

Domain-list matches are runtime policy evidence. If the final action is
`metadata_only` or `disabled`, the persisted event must not include domain,
matched domain, source URL, list file, full URL, path, query, or title. Keep the
category and policy reason instead. Domain evidence may be retained only when
the final action is `rich`.

Do not classify from arbitrary visible text. A domain is eligible for policy only
when it comes from surface evidence such as `AXURL`, `AXDocument`, or an
explicit `http(s)` URL in the current window title. URLs mentioned inside chats,
terminal output, documents, or page text are diagnostics at most; they must not
downgrade the current app/window.

## Files

- `manifest.json`: source, license, update date, and default action for each
  list.
- `adult-content.domains.txt`: adult-domain seed.
- `banking-finance.domains.txt`: small curated finance seed.
- `gambling.domains.txt`: gambling-domain seed.
- `secret-management.domains.txt`: small curated credential and one-time secret seed.
- `social-media.domains.txt`: social-media domain seed.

Each `*.domains.txt` file is one normalized domain per line. Blank lines and
lines beginning with `#` are ignored.

## Sources

`adult-content.domains.txt` is generated from the StevenBlack hosts
`porn-only` variant:

- Project: https://github.com/StevenBlack/hosts
- Variant README: https://github.com/StevenBlack/hosts/blob/master/alternates/porn-only/readme.md
- Raw hosts file: https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts
- Source date used here: 2026-07-05
- Upstream reported unique domains: 76,749
- Normalized domains stored here: 76,744

StevenBlack is an aggregator. The `porn-only` README lists source licenses for
the variant; as of this snapshot the contributing adult sources are MIT and CC
BY 4.0. Keep attribution when redistributing this connector package, and audit
the upstream README before refreshing the generated list.

`gambling.domains.txt` is generated from the StevenBlack hosts `gambling-only`
variant:

- Variant README: https://github.com/StevenBlack/hosts/blob/master/alternates/gambling-only/readme.md
- Raw hosts file: https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-only/hosts
- Source date used here: 2026-07-05
- Upstream reported unique domains: 6,264
- Normalized domains stored here: 6,264
- Upstream sources listed by StevenBlack for this variant are MIT.

`social-media.domains.txt` is generated from the StevenBlack hosts `social-only`
variant:

- Variant README: https://github.com/StevenBlack/hosts/blob/master/alternates/social-only/readme.md
- Raw hosts file: https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/social-only/hosts
- Source date used here: 2026-07-05
- Upstream reported unique domains: 3,244
- Normalized domains stored here: 3,244
- Upstream source listed by StevenBlack for this variant is MIT.

The finance and secret-management lists are intentionally small project-owned
seeds. They are not comprehensive category databases. Add entries only when
they are high-confidence and useful for default privacy behavior.

## Refreshing StevenBlack Domains

Fetch the raw hosts file for the variant, then regenerate a domain-only list:

```sh
curl -L https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts -o /tmp/stevenblack-porn-only-hosts
awk 'BEGIN { IGNORECASE=1 } /^[[:space:]]*#/ { next } NF >= 2 { d=tolower($2); gsub(/\r/, "", d); if (d != "" && d != "localhost" && d !~ /[^a-z0-9.-]/ && d ~ /\./) print d }' /tmp/stevenblack-porn-only-hosts | sort -u > adult-content.domains.txt
```

Use the same parser for `social-only` and `gambling-only`, changing the raw URL
and output file. After refreshing, update `manifest.json` with the upstream date
and entry count. The current generator skips hostnames containing underscores,
which accounts for the small difference between the upstream adult count and the
normalized adult file stored here.

## Policy Notes

Sensitive lists should normally map to `metadata_only`, not `disabled`. The
default goal is to preserve the attention envelope while excluding rich context
such as AX text, typed values, page body text, terminal viewport text, or DM
composer text.

`adult_content`, `banking_finance`, `gambling`, `private_browsing`, and
`secret_management` are default-sensitive in v0. `private_browsing` is a browser
mode category, not a domain-list-backed category. `social_media` is indexed as
classification evidence but is not default-sensitive; users can opt that
category into metadata-only or disabled through connector config.
