@smoke @public
Feature: Health & smoke
  The system under test is up and the seeded demo parcel is publicly trackable.
  Read-only and public, so it is safe against any environment.

  Scenario: GET /health reports the API is up
    Given url apiBaseUrl
    And path 'health'
    When method get
    Then status 200
    And match response.status == 'ok'
    And match response.service == 'api'

  Scenario: the seeded demo parcel is publicly trackable
    Given url apiV1
    And path 'tracking', demoTrackingCode
    When method get
    Then status 200
    And match response.trackingCode == demoTrackingCode
    And match response.status == '#? _ != null && _.length > 0'
