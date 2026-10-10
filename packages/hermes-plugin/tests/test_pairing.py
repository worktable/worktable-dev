import pytest

from worktable_hermes import pairing


def serve(monkeypatch, polls):
    calls = []

    def fake_request(url, body=None, token=None):
        calls.append((url.rsplit("/api/", 1)[-1], body))
        if url.endswith("/api/pairing/requests"):
            return {"code": "BCDF-GHJK", "pollToken": "poll-secret", "approvalUrl": "http://w/connect?code=BCDF-GHJK", "interval": 1}
        return polls.pop(0)

    monkeypatch.setattr(pairing, "_request", fake_request)
    return calls


def test_waits_for_approval_and_returns_the_approved_code(monkeypatch):
    calls = serve(monkeypatch, [{"status": "pending"}, {"status": "approved", "code": "T83PD-NSQDP"}])
    shown = []
    code = pairing.request_approval(
        "http://w", "hci_test_install", "studio", "Ada", lambda c, url: shown.append(c), sleep=lambda _: None
    )
    assert code == "T83PD-NSQDP"
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
