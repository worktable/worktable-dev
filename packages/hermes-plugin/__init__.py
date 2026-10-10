try:
    from .worktable_hermes.plugin import register
except ImportError:  # Imported as a top-level module, as test collection does.
    from worktable_hermes.plugin import register

__all__ = ["register"]
