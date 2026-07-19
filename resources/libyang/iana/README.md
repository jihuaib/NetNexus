# Pinned IANA YANG modules

These files are unmodified snapshots from the IANA YANG Parameters registry.
They provide the RFC 8639 subscribed-notifications and RFC 8641 YANG-Push
schemas, together with the dependency closure not supplied by libyang itself.

`manifest.json` pins the registry URL, revision-qualified filenames, and
SHA-256 digests. Both runtime build scripts verify this source directory before
copying the modules. Runtime verification checks the packaged copies again.

When updating a module, download it from the registry URL in `manifest.json`,
review the standards revision and dependency closure, update its SHA-256, and
run the libyang packaging and smoke tests. Do not edit an IANA module locally.
