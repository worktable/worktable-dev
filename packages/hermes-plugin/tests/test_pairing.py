import pytest

from worktable_hermes import pairing


def serve(monkeypatch, polls, **created):
    calls = []

    def fake_request(url, body=None, token=None):
        calls.append((url.rsplit("/api/", 1)[-1], body))
        if url.endswith("/api/pairing/requests"):
            return {"code": "BCDF-GHJK", "pollToken": "poll-secret", "approvalUrl": "http://w/connect?code=BCDF-GHJK", "interval": 1, **created}
        return polls.pop(0)

    monkeypatch.setattr(pairing, "_request", fake_request)
    return calls


def test_waits_for_approval_and_returns_the_approved_code(monkeypatch):
    calls = serve(monkeypatch, [{"status": "pending"}, {"status": "approved", "code": "T83PD-NSQDP"}])
    shown = []
    code, server = pairing.request_approval(
        "http://w", "hci_test_install", "studio", "Ada", lambda c, url: shown.append(c), sleep=lambda _: None
    )
    assert (code, server) == ("T83PD-NSQDP", "http://w")
    assert shown == ["BCDF-GHJK"]
    assert calls[0] == (
        "pairing/requests",
        {"target": {"kind": "agent-adapter", "adapter": "hermes", "installationId": "hci_test_install"}, "hostname": "studio", "name": "Ada"},
    )


def test_stops_when_the_owner_declines(monkeypatch):
    serve(monkeypatch, [{"status": "pending"}, {"status": "denied"}])
    with pytest.raises(pairing.PairingError) as error:
        pairing.request_approval("http://w", "hci_test_install", "studio", None, lambda *_: None, sleep=lambda _: None)
    assert error.value.code == "DENIED"


def test_stops_waiting_when_the_request_expires(monkeypatch):
    serve(monkeypatch, [{"status": "unexpected"}], expiresAt="2020-01-01T00:00:00.000Z")
    with pytest.raises(pairing.PairingError) as error:
        pairing.request_approval("http://w", "hci_test_install", "studio", None, lambda *_: None, sleep=lambda _: None)
    assert error.value.code == "EXPIRED"


def test_pairs_with_the_cloud_workspace_its_owner_approved(monkeypatch):
    serve(monkeypatch, [{"status": "approved", "code": "T83PD-NSQDP", "server": "https://app.worktable.cloud/w/ws_1/"}])
    assert pairing.request_approval(
        "https://app.worktable.cloud", "hci_test_install", "studio", None, lambda *_: None, sleep=lambda _: None
    ) == ("T83PD-NSQDP", "https://app.worktable.cloud/w/ws_1")
