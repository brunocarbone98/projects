Feature: Authentication
  Customers sign in to manage their shipments and wallet.

  Scenario: Sign in with valid credentials
    When I sign in with the demo customer credentials
    Then the response status should be 200

  Scenario: Sign in with a wrong password
    When I sign in with a wrong password
    Then the response status should be 401
    And the error code should be "INVALID_CREDENTIALS"
