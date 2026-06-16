Feature: Creating shipments
  A signed-in customer can create a shipment and gets a tracking number.

  Scenario: A signed-in customer creates a shipment
    Given I am signed in as a new customer
    When I create a shipment
    Then the response status should be 201
    And the shipment status should be "CREATED"
    And the shipment should have a valid tracking code

  Scenario: Creating a shipment requires authentication
    Given I am not signed in
    When I try to create a shipment
    Then the response status should be 401
