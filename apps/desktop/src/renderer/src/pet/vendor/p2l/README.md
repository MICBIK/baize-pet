# Vendored: PSD2Live web player (MIT)

Third-party code, **not** covered by this repository's AGPL-3.0 header rule
(see `LICENSE` in this folder and ADR 0008).

| File | Origin | License |
|---|---|---|
| `p2l.js` | `tsunehimatoi/psd2live` → `targets/web/src/main/resources/io/github/psd2live/targets/web/p2l.js` | MIT (`targets/web/LICENSE`) |
| `p2l_runtime.wasm` | same folder; WebAssembly build of `runtime/` | MIT (`runtime/LICENSE`) |

- Upstream commit: `acfe0d764e984319d8d76f67be7c3d0fe1a79b9f` (2026-11-08)
- sha256 `p2l.js`: `d4732ce620d7bf5cb37495f16a8129f8df2ca352ea40b27640dbdd49e771878d`
- sha256 `p2l_runtime.wasm`: `d8bbff52f27aebd40baca94139f9eca5af0f9d2a07c1c70fc5c15633121862a7`

Rules:

- Do not edit these files. To update, copy `p2l.js` and `p2l_runtime.wasm` from the
  `web` export of the **same PSD2Live build** that exported the character's
  `.p2lrt` (the format is versioned; player and model must match), then update
  the commit and hashes above.
- Only these MIT modules may enter the repo. The PSD2Live editor, engine
  (`umamo`) and its Cubism/PSD exporters are GPL-3.0 and stay an external tool.
