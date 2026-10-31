"""Exception hierarchy. Every error a user can hit maps to one class and one exit code (see cli)."""


class DramaFetchError(Exception):
    """Base class; the message is always safe to print (never contains cookies or tokens)."""


class UnsupportedUrlError(DramaFetchError):
    """The pasted text is not a TikTok short-drama, series or video URL we know how to handle."""


class DiscoveryError(DramaFetchError):
    """The series could not be resolved into an episode list."""


class LoginRequiredError(DiscoveryError):
    """TikTok answered with its login page or with empty lists: a logged-in session is needed."""


class ChallengeError(DiscoveryError):
    """TikTok showed a captcha / 'verify you are human' page instead of the series."""


class EpisodeDownloadError(DramaFetchError):
    """One episode could not be downloaded; carries a DownloadStatus-compatible `kind`."""

    def __init__(self, message: str, kind: str = "failed") -> None:
        super().__init__(message)
        self.kind = kind
