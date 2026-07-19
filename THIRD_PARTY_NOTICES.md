# Third-Party Notices

NetNexus is licensed under the MIT License. See `LICENSE` for the project
license text.

This file lists production npm packages and native runtimes bundled with the
application. It does not replace the license files included by each package.

## Native YANG runtime

| Component | Version | License | Source |
| --- | --- | --- | --- |
| libyang / yanglint | 5.8.6 | BSD-3-Clause | https://github.com/CESNET/libyang |
| PCRE2 | 10.47 | BSD-3-Clause WITH PCRE2-exception | https://github.com/PCRE2Project/pcre2 |
| IETF/IANA YANG modules | RFC-pinned revisions | IETF Trust Legal Provisions | https://www.iana.org/assignments/yang-parameters/ |
| getopt (Windows runtime) | f46459cbe64b | Unlicense | https://github.com/matveyt/getopt |
| PThreads4W (Windows runtime) | 3.0.0#14 | Apache-2.0 | https://sourceforge.net/projects/pthreads4w/ |
| dirent (Windows runtime) | 1.26 | MIT | https://github.com/tronkko/dirent |

The libyang and PCRE2 license texts are shipped at the root of the bundled
runtime. The generated Windows runtime also contains `LICENSE.getopt`,
`LICENSE.pthreads`, `NOTICE.pthreads`, and `LICENSE.dirent`. These components
are statically linked into `yanglint.exe`; no third-party runtime DLL is
required. The pinned IANA YANG files retain their complete IETF Trust copyright
and legal-provisions notices in each module.

## Production npm packages

| Package | Version | License | Source |
| --- | --- | --- | --- |
| @nodable/entities | 3.0.0 | MIT | https://github.com/nodable/val-parsers.git |
| ajv-formats | 2.1.1 | MIT | git+https://github.com/ajv-validator/ajv-formats.git |
| ajv | 8.17.1 | MIT | ajv-validator/ajv |
| argparse | 2.0.1 | Python-2.0 | nodeca/argparse |
| asn1-ber | 1.2.2 | MIT | git://github.com/markabrahams/node-asn1-ber.git |
| asn1 | 0.2.6 | MIT | https://github.com/joyent/node-asn1.git |
| atomically | 1.7.0 | MIT | https://github.com/fabiospampinato/atomically.git |
| bcrypt-pbkdf | 1.0.2 | BSD-3-Clause | git://github.com/joyent/node-bcrypt-pbkdf.git |
| better-sqlite3 | 11.10.0 | MIT | https://github.com/WiseLibs/better-sqlite3.git |
| buildcheck | 0.0.7 | MIT | http://github.com/mscdex/buildcheck.git |
| builder-util-runtime | 9.3.1 | MIT | git+https://github.com/electron-userland/electron-builder.git |
| conf | 10.2.0 | MIT | sindresorhus/conf |
| cpu-features | 0.0.10 | MIT | https://github.com/mscdex/cpu-features.git |
| debounce-fn | 4.0.0 | MIT | sindresorhus/debounce-fn |
| debug | 4.4.1 | MIT | git://github.com/debug-js/debug.git |
| dot-prop | 6.0.1 | MIT | sindresorhus/dot-prop |
| electron-log | 5.4.2 | MIT | megahertz/electron-log |
| electron-store | 8.2.0 | MIT | sindresorhus/electron-store |
| electron-updater | 6.6.2 | MIT | git+https://github.com/electron-userland/electron-builder.git |
| env-paths | 2.2.1 | MIT | sindresorhus/env-paths |
| fast-deep-equal | 3.1.3 | MIT | git+https://github.com/epoberezkin/fast-deep-equal.git |
| fast-xml-builder | 1.3.0 | MIT | https://github.com/NaturalIntelligence/fast-xml-builder.git |
| fast-xml-parser | 5.10.1 | MIT | https://github.com/NaturalIntelligence/fast-xml-parser.git |
| fast-uri | 3.0.6 | BSD-3-Clause | git+https://github.com/fastify/fast-uri.git |
| find-up | 3.0.0 | MIT | sindresorhus/find-up |
| fs-extra | 10.1.0 | MIT | https://github.com/jprichardson/node-fs-extra |
| graceful-fs | 4.2.11 | ISC | https://github.com/isaacs/node-graceful-fs |
| iconv-lite | 0.6.3 | MIT | git://github.com/ashtuchkin/iconv-lite.git |
| ipaddr.js | 2.2.0 | MIT | git://github.com/whitequark/ipaddr.js |
| is-obj | 2.0.0 | MIT | sindresorhus/is-obj |
| is-unsafe | 2.0.0 | MIT | https://github.com/NaturalIntelligence/is-unsafe |
| js-yaml | 4.1.0 | MIT | nodeca/js-yaml |
| json-schema-traverse | 1.0.0 | MIT | git+https://github.com/epoberezkin/json-schema-traverse.git |
| json-schema-typed | 7.0.3 | BSD-2-Clause | https://github.com/typeslick/json-schema-typed.git |
| jsonfile | 6.1.0 | MIT | git@github.com:jprichardson/node-jsonfile.git |
| lazy-val | 1.0.5 | MIT | develar/lazy-val |
| locate-path | 3.0.0 | MIT | sindresorhus/locate-path |
| lodash.escaperegexp | 4.1.2 | MIT | lodash/lodash |
| lodash.isequal | 4.5.0 | MIT | lodash/lodash |
| mimic-fn | 2.1.0 | MIT | sindresorhus/mimic-fn |
| mimic-fn | 3.1.0 | MIT | sindresorhus/mimic-fn |
| ms | 2.1.3 | MIT | vercel/ms |
| nan | 2.23.0 | MIT | git://github.com/nodejs/nan.git |
| net-snmp | 3.26.3 | MIT | git://github.com/markabrahams/node-net-snmp.git |
| onetime | 5.1.2 | MIT | sindresorhus/onetime |
| p-limit | 2.3.0 | MIT | sindresorhus/p-limit |
| p-locate | 3.0.0 | MIT | sindresorhus/p-locate |
| p-try | 2.2.0 | MIT | sindresorhus/p-try |
| path-exists | 3.0.0 | MIT | sindresorhus/path-exists |
| path-expression-matcher | 1.6.2 | MIT | https://github.com/NaturalIntelligence/path-expression-matcher |
| pkg-up | 3.1.0 | MIT | sindresorhus/pkg-up |
| require-from-string | 2.0.2 | MIT | floatdrop/require-from-string |
| safer-buffer | 2.1.2 | MIT | git+https://github.com/ChALkeR/safer-buffer.git |
| sax | 1.4.1 | ISC | git://github.com/isaacs/sax-js.git |
| semver | 7.7.2 | ISC | git+https://github.com/npm/node-semver.git |
| smart-buffer | 4.2.0 | MIT | https://github.com/JoshGlazebrook/smart-buffer.git |
| ssh2 | 1.17.0 | MIT | http://github.com/mscdex/ssh2.git |
| strnum | 2.4.1 | MIT | https://github.com/NaturalIntelligence/strnum |
| tiny-typed-emitter | 2.1.0 | MIT | https://github.com/binier/tiny-typed-emitter.git |
| tweetnacl | 0.14.5 | Unlicense | https://github.com/dchest/tweetnacl-js.git |
| type-fest | 2.19.0 | (MIT OR CC0-1.0) | sindresorhus/type-fest |
| universalify | 2.0.1 | MIT | git+https://github.com/RyanZim/universalify.git |
| xml-naming | 0.3.0 | MIT | https://github.com/NaturalIntelligence/xml-naming |
