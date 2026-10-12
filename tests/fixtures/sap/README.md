# SAP OData V2 batch fixtures

Synthetic-but-realistic wire samples used as a golden corpus for the response
parser. **They are not captured from a live SAP system**; they are authored to
match the documented OData V2 batch formats (see the OData v2 batch processing
spec and SAP Gateway behavior for a collapsed changeset).

Bodies are stored with LF line endings for VCS stability. The parser normalizes
`\r?\n` to CRLF before parsing, so these fixtures exercise that path too; a test
converts one fixture to CRLF to prove the result is identical.

The outer `Content-Type` (batch boundary) is an HTTP response header, not part
of the body, so each test supplies it explicitly.

| File                                  | Scenario                                                              |
| ------------------------------------- | --------------------------------------------------------------------- |
| `changeset-success.multipart`         | One changeset, three successful operations                            |
| `changeset-collapsed-error.multipart` | A whole changeset rejected with a single HTTP error                   |
| `content-id.multipart`                | Changeset children carrying MIME `Content-ID` headers                 |
| `preamble.multipart`                  | MIME preamble (with a header-looking line) before the first delimiter |
| `retrieve-mixed.multipart`            | Direct GET part followed by a changeset (mixed layout)                |
