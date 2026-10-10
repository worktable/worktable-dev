"""Pure helpers that describe a claimed Worktable delivery."""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import unquote, urlsplit


def location(delivery: dict) -> dict:
    return delivery.get("location") or {"kind": "worktable"}


def conversation_id(delivery: dict) -> str:
    """One Hermes chat per Worktable thread and conversation identity."""
    where = location(delivery)
    thread = delivery.get("thread") or {}
    thread_id = delivery["threadId"]
    if where.get("kind") == "space":
        base = f"{where['spaceId']}/{thread_id}"
    else:
        base = f"worktable/{thread_id}"
    identity = next(
        (item for item in thread.get("identities") or [] if item.get("id") == delivery.get("identityId")),
        None,
    )
    return base if identity and identity.get("default") else f"{base}/{delivery['identityId']}"


def event_id(delivery: dict) -> str:
    return f"{conversation_id(delivery)}/{delivery['messageId']}"


def sender(delivery: dict) -> dict:
    message = delivery.get("message") or {}
    thread = delivery.get("thread") or {}
    member_id = message.get("authorMemberId") or message.get("authorId")
    if not member_id:
        raise ValueError("Worktable delivery has no message author")
    identity = next(
        (
            item
            for item in thread.get("identities") or []
            if item.get("id") == message.get("authorIdentityId") and item.get("memberId") == member_id
        ),
        None,
    )
    member = next((item for item in thread.get("members") or [] if item.get("id") == member_id), None)
    name = (identity or {}).get("name") or (member or {}).get("name") or member_id
    return {"id": member_id, "kind": (member or {}).get("kind", "agent"), "name": name}


def reply_for(delivery: dict, body: str, idempotency_key: str) -> dict:
    where = location(delivery)
    reply = {
        "location": where,
        "threadId": delivery["threadId"],
        "inReplyTo": delivery["messageId"],
        "responseTo": delivery["messageId"],
        "authorIdentityId": delivery["identityId"],
        "body": body,
        "idempotencyKey": idempotency_key,
    }
    if where.get("kind") == "space":
        reply["spaceId"] = where["spaceId"]
    return reply


def thread_for_conversation(conversation: str) -> Optional[dict]:
    """The Worktable thread a Hermes chat id addresses, for messages Hermes starts itself."""
    parts = conversation.split("/")
    if len(parts) not in (2, 3) or not all(parts):
        return None
    scope, thread_id = parts[0], parts[1]
    thread: dict = (
        {"location": {"kind": "worktable"}, "threadId": thread_id}
        if scope == "worktable"
        else {"location": {"kind": "space", "spaceId": scope}, "threadId": thread_id, "spaceId": scope}
    )
    if len(parts) == 3:
        thread["authorIdentityId"] = parts[2]
    return thread


_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_LINK = re.compile(r"(\]\()?<?(https?://[^\s<>)\]]+)>?", re.IGNORECASE)


def _outside_inline_code(text: str, transform) -> str:
    output, start, index = "", 0, 0
    while index < len(text):
        if text[index] != "`":
            index += 1
            continue
        end = index + 1
        while end < len(text) and text[end] == "`":
            end += 1
        width, closing, matched = end - index, end, None
        while (closing := text.find("`", closing)) != -1:
            closing_end = closing + 1
            while closing_end < len(text) and text[closing_end] == "`":
                closing_end += 1
            if closing_end - closing == width:
                matched = closing_end
                break
            closing = closing_end
        if matched is None:
            index = end
            continue
        output += transform(text[start:index]) + text[index:matched]
        start = index = matched
    return output + transform(text[start:])


def _prose_only(markdown: str, transform) -> str:
    output, prose, fence = "", "", None
    for line in markdown.splitlines(keepends=True):
        content = line.rstrip("\n")
        opening = _FENCE.match(content)
        if fence is None and opening and (opening.group(1)[0] == "~" or "`" not in opening.group(2)):
            output += _outside_inline_code(prose, transform) + line
            prose, fence = "", (opening.group(1)[0], len(opening.group(1)))
            continue
        if fence is not None:
            output += line
            closing = re.match(r"^ {0,3}(`+|~+)[ \t]*\r?$", content)
            if closing and closing.group(1)[0] == fence[0] and len(closing.group(1)) >= fence[1]:
                fence = None
            continue
        if content.startswith(("    ", "\t")):
            output += _outside_inline_code(prose, transform) + line
            prose = ""
            continue
        prose += line
    return output + _outside_inline_code(prose, transform)


def portable_doc_links(body: str, space_id: str, worktable_origin: Optional[str]) -> str:
    """Rewrite absolute links to this Worktable's Docs as portable paths."""
    if not worktable_origin:
        return body
    known = urlsplit(worktable_origin)
    if not known.scheme or not known.netloc:
        return body
    origin = f"{known.scheme}://{known.netloc}".lower()

    def rewrite(match: re.Match) -> str:
        value, prefix, url_value = match.group(0), match.group(1), match.group(2)
        wrapped = bool(prefix) or value.startswith("<")
        trailing = "" if wrapped else (re.search(r"[,.;:!?]+$", url_value) or [""])[0]
        url_text = url_value[: -len(trailing)] if trailing else url_value
        url = urlsplit(url_text)
        if f"{url.scheme}://{url.netloc}".lower() != origin:
            return value
        doc = re.match(r"^/spaces/([^/]+)/docs/(.+)$", url.path)
        if not doc or (space_id and unquote(doc.group(1)) != space_id):
            return value
        suffix = (f"?{url.query}" if url.query else "") + (f"#{url.fragment}" if url.fragment else "")
        portable = f"/{doc.group(2)}{suffix}" if space_id else f"{url.path}{suffix}"
        return f"{prefix}{portable}{trailing}" if prefix else f"[{portable}]({portable}){trailing}"

    return _prose_only(body, lambda prose: _LINK.sub(rewrite, prose))
