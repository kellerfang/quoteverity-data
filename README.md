# QuoteVerity public model data

This repository builds the public, non-user data used by QuoteVerity's planning tools. It contains no names, addresses, quotes, phone numbers, email addresses, cookies, or form submissions.

The unattended scheduled runner downloads structured public releases, validates units and coverage, and publishes `dist/model-data.json`. A failed source, out-of-range value, incomplete ZIP index, or failed validation prevents replacement of the last known-good file. The extraction, validation, scoring, and publication path is deterministic and does not use generative AI or require per-update human approval.

Current upstream sources:

- U.S. Bureau of Labor Statistics OEWS API, hourly median wage (data type 08) for the four relevant occupations at state and national level.
- U.S. Energy Information Administration monthly residential electricity and natural-gas prices.
- EPA ENERGY STAR certified gas and heat-pump water-heater datasets.
- ReadyAPIs curated U.S. ZIP reference, used under CC BY 4.0.
- U.S. Bureau of Economic Analysis state and metro Regional Price Parity archives.

The production job runs every Tuesday at 09:17 UTC from an isolated temporary checkout. Source frequencies differ: ENERGY STAR, EIA, ZIP geography, and BEA archives are checked each run, while OEWS and BEA RPP normally change annually. The site continues using its last validated snapshot if any update fails.
