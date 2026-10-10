import pytest

from worktable_hermes import pairing


def serve(monkeypatch, polls, **created):
    calls = []

    def fake_request(url, body=None, token=None):
        calls.append((url.rsplit("/api/", 1)[-1], body))
        if url.endswith("/api/pairing/requests"):
            return {"code": "BCDF-GHJK", "pollToken": "poll-secret", "approvalUrl": "http://w/connect?code=BCDF-GHJK", "interval": 1, **created}
        result = polls.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

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


def test_keeps_waiting_through_a_brief_outage_but_not_past_a_refusal(monkeypatch):
    serve(
        monkeypatch,
        [
            pairing.PairingError("Could not reach Worktable", "UNREACHABLE"),
            pairing.PairingError("Busy", "HTTP_503", 503),
            {"status": "approved", "code": "T83PD-NSQDP"},
        ],
    )
    code, _ = pairing.request_approval("http://w", "hci_test_install", "studio", None, lambda *_: None, sleep=lambda _: None)
    assert code == "T83PD-NSQDP"

    serve(monkeypatch, [pairing.PairingError("Unknown connection request", "NOT_FOUND", 404)])
    with pytest.raises(pairing.PairingError) as error:
        pairing.request_approval("http://w", "hci_test_install", "studio", None, lambda *_: None, sleep=lambda _: None)
    assert error.value.code == "NOT_FOUND"


def test_a_connection_cut_mid_answer_is_retryable(monkeypatch):
    import http.client

    class Cut:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self):
            raise http.client.IncompleteRead(b"{")

    monkeypatch.setattr(pairing.urllib.request, "urlopen", lambda *_, **__: Cut())
    with pytest.raises(pairing.PairingError) as error:
        pairing._request("http://w/api/pairing/requests/poll", {"pollToken": "x"})
    assert error.value.code == "UNREACHABLE"
    assert error.value.status is None


def test_a_cut_off_error_answer_keeps_its_status(monkeypatch):
    import http.client
    import urllib.error

    class CutBody:
        def read(self, *_):
            raise http.client.IncompleteRead(b"{")

        def close(self):
            pass

    def fail(*_, **__):
        raise urllib.error.HTTPError("http://w", 503, "Busy", {}, CutBody())

    monkeypatch.setattr(pairing.urllib.request, "urlopen", fail)
    with pytest.raises(pairing.PairingError) as error:
        pairing._request("http://w/api/pairing/requests/poll", {"pollToken": "x"})
    assert error.value.status == 503
