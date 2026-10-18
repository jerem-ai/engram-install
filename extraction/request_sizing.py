"""Pure request-window sizing for memory extraction backends.

This module deliberately has no extractor or provider dependencies so the safety
calculation can be regression-tested in a clean environment.
"""

CTX_GRANULARITY = 8192
CHARS_PER_TOKEN = 3.7


def size_request(system: str, user_block: str, ctx_cap: int) -> tuple[int, int, float]:
    """Choose a context window and timeout that fit this prompt.

    Ollama truncates oversized prompts from the front, which can discard the
    extraction system prompt. Refuse requests that cannot fit instead.
    """
    est = (len(system) + len(user_block)) / CHARS_PER_TOKEN
    need = int(est * 1.15) + 1024
    if need > ctx_cap:
        raise ValueError(
            f"prompt ~{est:,.0f} tokens needs ~{need:,} ctx, above the {ctx_cap:,} cap — "
            f"refusing, as front-truncation would drop the system prompt. Raise "
            f"--num-ctx or lower MAX_SESSION_CHARS."
        )
    num_ctx = min(
        ctx_cap,
        max(CTX_GRANULARITY, -(-need // CTX_GRANULARITY) * CTX_GRANULARITY),
    )
    # Budget for window allocation and prefill. The coefficients intentionally
    # leave generous headroom; an over-large timeout is cheaper than losing an
    # entire extraction run to a slow but healthy request.
    timeout = max(900, int(num_ctx / 1024 * 10 + est / 1024 * 14))
    return num_ctx, timeout, est
