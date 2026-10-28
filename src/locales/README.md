# Bundled user-interface languages

Simplified Chinese is the source language. `source.json` inventories authored UI phrases; ten JSON catalogs provide English, Traditional Chinese, Spanish, French, German, Portuguese, Russian, Arabic, Japanese and Hindi. English is bundled eagerly for startup/fallback; other catalogs load on demand. No translation service is called at runtime.

`reviewed.json` records the explicitly corrected core labels and safety copy. Initial drafts were generated locally with the MIT-licensed [M2M100 model](https://huggingface.co/facebook/m2m100_418M); Traditional Chinese uses OpenCC with product terminology overrides. Full native-speaker review has not been performed.

Only source-code strings may enter `uiLiteral`; `uiTemplate` translates static parts while preserving interpolated values. Never translate a user’s message, filename, room/device name, email, feedback, recovery material or an entire rendered DOM tree. `t` performs exact known-phrase lookup for app copy/errors. Catalog values must contain no HTML/attribute delimiters (`<`, `>`, `&`, quotes), since some static strings appear in trusted markup. The locale contract test enforces coverage and this constraint.

When adding UI copy, update the source inventory and all ten catalogs, preserve placeholders as template values, check longer translations and Arabic direction, and run the language tests. Application behavior must use stable IDs/error codes; the legacy back-button normalizer uses source-copy lookup rather than matching translated words.
