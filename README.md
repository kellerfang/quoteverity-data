# QuoteVerity public model data

This repository builds the public, non-user data used by QuoteVerity's planning tools. It contains no names, addresses, quotes, phone numbers, email addresses, cookies, or form submissions.

The scheduled workflow downloads structured public releases, validates units and coverage, and publishes `dist/model-data.json`. A failed source, out-of-range value, incomplete ZIP index, or failed validation prevents replacement of the last known-good file.

Current upstream sources:

- U.S. Bureau of Labor Statistics May 2025 OEWS state and national wage files.
- U.S. Energy Information Administration monthly residential electricity and natural-gas prices.
- EPA ENERGY STAR certified gas and heat-pump water-heater datasets.
- ReadyAPIs curated U.S. ZIP reference, used under CC BY 4.0.

The job runs every Tuesday. Source frequencies differ: ENERGY STAR and EIA can change between runs, ZIP geography is checked monthly, and OEWS is replaced when BLS publishes a new annual file. The site continues using its last validated snapshot if any update fails.
