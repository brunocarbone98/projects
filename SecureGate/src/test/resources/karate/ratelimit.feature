@ratelimit
Feature: Public endpoint rate limiting
  Security check — the public tracking endpoint throttles aggressive callers with 429.

  # Tagged @ratelimit and EXCLUDED from the default run: hammering the endpoint consumes the per-IP
  # budget (default 60 requests / 60s) and would make the other public tracking scenarios receive
  # 429 instead of their expected 200/400/404. Opt in with -Dsg.ratelimit=true, which runs this
  # feature in isolation (single-threaded, AFTER the main suite) so nothing public is throttled —
  # see ApiKarateTest#runApiSuite.

  Scenario: aggressive tracking requests are throttled with 429 RATE_LIMITED
    * url apiV1
    * def hitRateLimit =
      """
      function() {
        for (var i = 0; i < 90; i++) {
          var res = karate.call('classpath:karate/helpers/track-once.feature', { code: demoTrackingCode });
          if (res.responseStatus == 429) {
            return true;
          }
        }
        return false;
      }
      """
    * assert hitRateLimit()
