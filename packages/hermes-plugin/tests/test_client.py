from worktable_hermes.client import WorktableError, WorktableTools


async def test_asks_for_comments_until_a_worktable_refuses_the_option_then_claims_without_it():
    requests = []

    async def call(tool, arguments, timeout):
        request = arguments["request"]
        requests.append(request)
        if "comments" in request:
            raise WorktableError("WORKTABLE_ERROR", 'Invalid arguments: Unrecognized key: "comments"')
        return {"delivery": None}

    tools = WorktableTools(call)
    assert await tools.claim(0) is None
    assert await tools.claim(0) is None
    assert ["comments" in request for request in requests] == [True, False, False]
