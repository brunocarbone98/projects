Feature: Wallet
  Balance / ledger contract, top-up, idempotency and authn for the customer wallet.

  Background:
    * url apiV1

  Scenario: a fresh wallet starts empty and matches the contract
    * def user = call read('classpath:karate/helpers/register.feature')
    Given path 'wallet'
    And header Authorization = 'Bearer ' + user.accessToken
    When method get
    Then status 200
    And match response contains { balanceCents: '#number', currency: 'USD', entries: '#array' }
    And match response.balanceCents == 0

  Scenario: a top-up increases the balance by the amount
    * def user = call read('classpath:karate/helpers/register.feature')
    Given path 'wallet', 'topup'
    And header Authorization = 'Bearer ' + user.accessToken
    And request { amountCents: 5000, idempotencyKey: '#("topup-" + java.lang.System.nanoTime())' }
    When method post
    Then status 200
    And match response.balanceCents == 5000

  Scenario: retrying a top-up with the same idempotency key does not double-credit
    * def user = call read('classpath:karate/helpers/register.feature')
    * def body = { amountCents: 5000, idempotencyKey: '#("idem-" + java.lang.System.nanoTime())' }
    Given path 'wallet', 'topup'
    And header Authorization = 'Bearer ' + user.accessToken
    And request body
    When method post
    Then status 200

    # Same key again: the balance must remain 5000, not 10000.
    Given path 'wallet', 'topup'
    And header Authorization = 'Bearer ' + user.accessToken
    And request body
    When method post
    Then status 200
    And match response.balanceCents == 5000

  Scenario: reading the wallet without a token returns 401 UNAUTHENTICATED
    Given path 'wallet'
    When method get
    Then status 401
    And match response.error.code == 'UNAUTHENTICATED'
