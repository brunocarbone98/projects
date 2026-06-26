@public
Feature: Shipping quotes
  A visitor can price a parcel before creating a shipment — pricing contract and input validation
  of POST /api/v1/quote.

  Background:
    * url apiV1
    * def baseQuote = read('classpath:karate/data/quote.json')

  Scenario: a valid quote returns a price and ETA matching the contract
    Given path 'quote'
    And request baseQuote
    When method post
    Then status 200
    And match response contains { zoneCode: '#string', serviceLevel: '#string', billableWeightGrams: '#number', priceCents: '#number', currency: 'USD', etaMinDays: '#number', etaMaxDays: '#number', estimatedDeliveryAt: '#string' }
    And assert response.priceCents > 0
    And assert response.etaMinDays <= response.etaMaxDays
    And assert response.billableWeightGrams >= 2000

  Scenario: a missing destination country is rejected with 400
    * def body = karate.copy(baseQuote)
    * remove body.destinationCountry
    Given path 'quote'
    And request body
    When method post
    Then status 400
    And match response.error.code == 'VALIDATION_ERROR'

  Scenario: an over-limit weight is rejected with 400
    * def body = karate.copy(baseQuote)
    * set body.weightGrams = 80000
    Given path 'quote'
    And request body
    When method post
    Then status 400
    And match response.error.code == 'VALIDATION_ERROR'

  Scenario: an unknown service level is rejected with 400
    * def body = karate.copy(baseQuote)
    * set body.serviceLevel = 'PREMIUM'
    Given path 'quote'
    And request body
    When method post
    Then status 400
    And match response.error.code == 'VALIDATION_ERROR'
