@public
Feature: Public parcel tracking
  Anyone can track a parcel by its tracking number, with no account — contract, validation
  and not-found behaviour of GET /api/v1/tracking/:code.

  Background:
    * url apiV1

  Scenario: the seeded code returns the timeline and matches the contract
    Given path 'tracking', demoTrackingCode
    When method get
    Then status 200
    And match response contains { trackingCode: '#(demoTrackingCode)', status: '#string', serviceLevel: '#string', origin: '#object', destination: '#object', createdAt: '#string', events: '#[_ > 0]' }
    And match response.serviceLevel == '#? ["EXPRESS","STANDARD","ECONOMY"].indexOf(_) >= 0'
    And match response.origin contains { city: '#string', country: '#string' }
    And match response.destination contains { city: '#string', country: '#string' }
    And match each response.events contains { status: '#string', occurredAt: '#string' }
    And match each response.events == '#? _.status != null && _.status.length > 0'

  Scenario: a malformed code is rejected with 400 VALIDATION_ERROR
    Given path 'tracking', 'PTY-2026-1-9'
    When method get
    Then status 400
    And match response.error.code == 'VALIDATION_ERROR'

  Scenario: a well-formed code with a wrong check digit is not found (404)
    * def code = TrackingCodes.withWrongCheckDigit(2026, 1001)
    Given path 'tracking', code
    When method get
    Then status 404
    And match response.error.code == 'NOT_FOUND'

  Scenario: a valid but unknown code returns 404 NOT_FOUND
    * def code = TrackingCodes.build(2026, 987654)
    Given path 'tracking', code
    When method get
    Then status 404
    And match response.error.code == 'NOT_FOUND'
