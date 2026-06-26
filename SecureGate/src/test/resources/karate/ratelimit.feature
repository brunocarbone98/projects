@ratelimit
Feature: Public endpoint rate limiting
  Security check — the public tracking endpoint throttles aggressive callers with 429.

  # Tagged @ratelimit and EXCLUDED from the default run: hammering the endpoint consumes the per-IP
  # budget (default 60 requests / 60s) and would make the other public tracking scenarios receive
  # 429 instead of their expected 200/400/404. Opt in with -Dsg.ratelimit=true.

  Scenario: aggressive tracking requests are throttled with 429 RATE_LIMITED
    * url apiV1
    * def limited = false
    * def attempt =
      """
      function() {
        var res = karate.call('classpath:karate/helpers/track-once.feature', { code: demoTrackingCode });
        return res.responseStatus;
      }
      """
    * eval
      """
      for (var i = 0; i < 90 && !limited; i++) {
        if (attempt() == 429) { limited = true; }
      }
      """
    * assert limited
