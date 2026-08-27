from __future__ import annotations

import hashlib
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _canonical_text_hash(path: Path) -> str:
    value = path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
    value = value.strip("\n") + "\n"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def test_audited_native_notice_copies_are_stable() -> None:
    expected = {
        "WebView2-LICENSE.txt": "324083bf015092054be9d5851dafa1b79cbfab3331ff983476d502839515d8bb",
        "WebView2-NOTICE.txt": "106423785c5b7eba0a8e61d1837f2132e9c828e20ad530f565d981c1df60dd90",
        "DotNet-LICENSE.txt": "18647d26bc4c4d892a5fd29de1264d10906b3124cafa98313300ff300441c7f0",
        "DotNet-THIRD-PARTY-NOTICES.txt": "52bd2f19fdfde1128ecc91ce72a12f2bc2ac8e0de1039f02f80fde19a15890d1",
        "OpenSSL-LICENSE.txt": "9568a2b155e66ac3e0ba1fd80b52b827b9460e6cf6f233125e7cbca8e206ddc3",
        "libffi-LICENSE.txt": "deaf3a42effb551a5b140fa9afefed183a27f1341c6d1bf430d106a5e6931fc0",
    }
    for name, wanted in expected.items():
        assert _canonical_text_hash(ROOT / "third_party" / name) == wanted


def test_native_sources_are_immutable_and_inventory_is_fail_closed() -> None:
    build = (ROOT / "desktop" / "build-desktop.ps1").read_text(encoding="utf-8")
    expected_archive_hashes = {
        "PbsRuntimeArchiveSha256": "F91242B07E318D2540F9DA71162B92D494C39745ABDE9B994D7D906756453FC9",
        "PbsMetadataArchiveSha256": "3A6160F9E3502986D925B627AF13D6C98D977808F0986BCC03B44E73DBDA5AAA",
        "PbsProjectLicenseSha256": "1F256ECAD192880510E84AD60474EAB7589218784B9A50BC7CEEE34C2B91F1D5",
        "WebViewPackageSha256": "4C35A54835B63954159EAC1D5B7A60AE617A41DBB5B73BFDB11C4870A891080A",
        "NetStandardPackageSha256": "B385221FCE3C6BEA76C96C0C1FEF0F6981A740BDAA9D8D069A2C6878BBE48434",
        "NetFxPackageSha256": "218DD4C63D3F800DE697BCA41178827A52DF0A9EC7A9B47520327D91EBC7051C",
    }
    for variable, wanted in expected_archive_hashes.items():
        match = re.search(rf'\${variable}\s*=\s*"([0-9A-F]{{64}})"', build)
        assert match and match.group(1) == wanted

    assert '$PbsRelease = "20260825"' in build
    assert '$PbsCommit = "c0aa3bbdc2fff56a77ad1ecec68b1e47794d8779"' in build
    assert '$NetFxVersion = "2.0.1-servicing-26011-01"' in build
    assert "Expected 80 NETStandard.Library 2.0.1 facade matches" in build
    assert "Assert-SameFileHash" in build
    assert "schema = 2" in build
    assert 'version = "3.5.8"' not in build
    assert 'version = "ABI 8' not in build


def test_release_packager_requires_and_verifies_native_legal_bundle() -> None:
    package = (ROOT / "desktop" / "package-release.ps1").read_text(encoding="utf-8")
    required_fragments = (
        "WebView2-NOTICE.txt",
        "DotNet-NETFramework-LICENSE.txt",
        "DotNet-NETFramework-THIRD-PARTY-NOTICES.txt",
        "python-build-standalone\\PYTHON.json",
        "LICENSE.openssl-3.txt",
        "LICENSE.libffi.txt",
        "Native component inventory schema must be 2",
        "Inventoried native file hash mismatch",
        "Inventoried license/notice is missing",
        "Git HEAD changed while the release package was being built",
        "The release build modified the Git working tree",
    )
    for fragment in required_fragments:
        assert fragment in package

    for source in (
        "python-build-standalone-runtime",
        "python-build-standalone-metadata",
        "Microsoft.Web.WebView2",
        "NETStandard.Library.NETFramework",
    ):
        assert source in package
