@ignore
Feature: Track a code once (no assertion)

  # Reusable helper for the rate-limit loop: fires a single GET /tracking/:code and exposes the HTTP
  # status as `responseStatus`, without asserting it (the caller decides when 429 is expected).

  Scenario: track
    Given url apiV1
    And path 'tracking', code
    When method get
    # `responseStatus` is set automatically by Karate and returned to the caller.
