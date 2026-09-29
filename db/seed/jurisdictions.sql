-- Launch jurisdictions (reference data, idempotent). Rules stay empty until each
-- pack is collected from primary sources and verified (phase 2+). Inactive
-- until then: only active jurisdictions accept listings.
insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone, measurement, active)
values
  ('TN', 'TN', 'Tunisia',        'TND', 'fr-TN', '{ar,fr,en}', 'Africa/Tunis',  'metric', false),
  ('FR', 'FR', 'France',         'EUR', 'fr-FR', '{fr,en}',    'Europe/Paris',  'metric', false),
  ('GB', 'GB', 'United Kingdom', 'GBP', 'en-GB', '{en}',       'Europe/London', 'metric', false)
on conflict (code) do update set
  country_code = excluded.country_code, name = excluded.name, default_currency = excluded.default_currency,
  default_locale = excluded.default_locale, languages = excluded.languages, timezone = excluded.timezone,
  measurement = excluded.measurement;
