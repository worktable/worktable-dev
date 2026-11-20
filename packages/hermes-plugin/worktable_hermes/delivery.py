"""Pure helpers that describe a claimed Worktable delivery."""

from __future__ import annotations

import hashlib
import re
from typing import Optional
from urllib.parse import unquote, urlsplit


def location(delivery: dict) -> dict:
    return delivery.get("location") or {"kind": "worktable"}


def is_comments(delivery: dict) -> bool:
    """A page of comments sent to this agent, rather than a thread message."""
    return delivery.get("kind") == "comments"


def conversation_id(delivery: dict) -> str:
    """One Hermes chat per Worktable thread and conversation identity, or per commented page."""
    if is_comments(delivery):
        page = delivery["page"]
        return f"{page['spaceId']}/comments/{page['path']}"
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
    if is_comments(delivery):
        # A batch keeps its id across retries, so a retried page finds the
        # answer Hermes already gave it. Without one, the same comments make
        # the same event.
        batch = delivery.get("batchId") or hashlib.sha256(
            ",".join(sorted(comment["requestId"] for comment in delivery["comments"])).encode()
        ).hexdigest()[:22]
        return f"{conversation_id(delivery)}/{batch}"
    return f"{conversation_id(delivery)}/{delivery['messageId']}"


def authors(delivery: dict) -> list[dict]:
    """Whose words start the turn; each must pass the owner rule."""
    if not is_comments(delivery):
        return [sender(delivery)]
    found = []
    for comment in delivery["comments"]:
        author = comment.get("from") or {}
        found.append(
            {
                "id": author.get("id") or "",
                "kind": author.get("kind") or "unknown",
                "name": author.get("name") or author.get("id") or "Someone",
                # For an agent, who connected it: each author is judged on its own.
                **({"connectedBy": author["connectedBy"]} if "connectedBy" in author else {}),
            }
        )
    return found


def comments_text(delivery: dict) -> str:
    """The comments, as the agent reads them: where, what each says, and how to answer."""
    page, comments = delivery["page"], delivery["comments"]
    where = f"“{page['title']}” ({page['path']}, Space {page['spaceId']})"
    lines = [
        f"A comment on {where} was sent to you in Worktable."
        if len(comments) == 1
        else f"{len(comments)} comments on {where} were sent to you in Worktable."
    ]
    for comment in comments:
        lines += ["", f"Comment {comment['annotationId']}, from {(comment.get('from') or {}).get('name', 'someone')}:"]
        if comment.get("quote"):
            lines.append(f"On the text: “{comment['quote']}”")
        # Only the words that asked: earlier replies may come from people the
        # owner rule never checked. Hermes can read them with its tools.
        lines.append(comment.get("body") or "")
    lines += [
        "",
        "Do what they ask with your Worktable tools. You can answer a comment in it yourself; "
        "what you answer here is posted on each comment you didn't answer.",
    ]
    return "\n".join(lines)


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
    # An author the thread does not list is neither a person nor an agent here.
    return {"id": member_id, "kind": (member or {}).get("kind") or "unknown", "name": name}


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
    if len(parts) not in (2, 3) or not all(parts) or parts[1] == "comments":
        # A commented page's chat has no thread to post into.
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
