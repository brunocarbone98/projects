@ignore
Feature: Register a fresh, isolated customer

  # Reusable helper: registers a brand-new CUSTOMER and returns its identity + tokens. Calling
  # features get an isolated account (own shipments, own wallet), so they stay independent and
  # re-runnable. Use with:  * def user = call read('classpath:karate/helpers/register.feature')

  Background:
    * url apiV1

  Scenario: register
    * def email = freshEmail()
    Given path 'auth', 'register'
    And request { email: '#(email)', password: 'Password123!', name: 'SecureGate Bot' }
    When method post
    Then status 201
    * def email = email
    * def userId = response.user.id
    * def accessToken = response.tokens.accessToken
    * def refreshToken = response.tokens.refreshToken
