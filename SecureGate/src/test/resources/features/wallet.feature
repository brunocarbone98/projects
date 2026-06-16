Feature: Wallet top-up
  Customers fund a wallet they pay for shipping labels from.

  Scenario: A new customer tops up their wallet
    Given I am signed in as a new customer
    When I top up my wallet by 5000 cents
    Then the response status should be 200
    And my wallet balance should be 5000 cents
