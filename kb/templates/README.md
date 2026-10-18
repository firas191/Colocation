# Document templates (platform P9, D-108)

One JSON file per document type and country (`<CODE>/<kind>.json`; `GLOBAL/` for types with no legal content, such as
the house rules). `n8n/build_platform.py` builds them into the document workflows; nothing reads these files at run
time. A change is a new `version`, never an edit of a stored one: documents keep the version they were made with.

- `slots`: every value the text uses. `from` says where it comes from: `household` and `payment` are read from the
  database by the API, `user` is typed by the person (or proposed by the Document agent and confirmed). A document
  is refused (422, the missing slots listed) while a required slot is empty. A value for a slot that is not in the
  list is dropped.
- `text.<lang>`: the title and paragraphs, with `{{slot}}` markers. Nothing else is written into the PDF except the
  slot values, the sources, the notice and the template version.
- `sources`: the primary texts the document relates to, with the URL and the date they were read. A legal document
  type is offered for a country only when its template has sources (PLATFORM_SPEC 3.7). The TN texts were read on
  jurisitetunisie.com, a private site that reproduces the code, because the official portal (legislation.tn) refuses
  automated reading (robots.txt); each source says so.
- The paragraphs that mention the law say what the cited article says, in plain words, and nothing more. They are
  not legal advice; every PDF carries the notice `documents-notice-v1`.

Not available yet: every legal document type for FR (Légifrance could not be read from here, 2026-10-17), and every
type except the rent receipt for GB.
