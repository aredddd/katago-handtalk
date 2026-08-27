# Legacy screenshot-recognition weight location

New installations should place the two user-supplied files under
`models/vision/`. This directory remains a fallback so existing local setups do
not break:

- `board.pth`
- `stone.pth`

The large weight files are intentionally excluded from Git and every release.
Only use locally obtained compatible files when you have the right to do so,
and do not redistribute them with this project. See
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
