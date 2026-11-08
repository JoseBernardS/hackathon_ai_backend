# Parked: peer review / resolution tracking

Removed on request to get back to basics. Nothing here is referenced by the
running app. To restore, move the files back:

    mv _parked/peer-review/src-models/Outcome.js            src/models/
    mv _parked/peer-review/src-services/*.js                src/services/
    mkdir -p scripts/lib
    mv _parked/peer-review/scripts/seed-outcomes.js         scripts/
    mv _parked/peer-review/scripts-lib/exif-inject.js       scripts/lib/
    mv _parked/peer-review/docs/RESOLUTION.md               docs/

...then re-apply the wiring listed in REMOVED.md at the repo root.
