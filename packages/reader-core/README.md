# reader-core

This package is the shared home for reader logic that will gradually be reused by both apps in the monorepo:

- sentence segmentation
- click-to-offset mapping
- DOM range reconstruction
- word and sentence highlighting
- playback state helpers

Right now the web app and the Chrome extension still keep their reader implementations locally, but this package is the place to consolidate them next.
