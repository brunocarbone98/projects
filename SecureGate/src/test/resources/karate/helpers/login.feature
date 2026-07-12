@ignore
Feature: Log in and return an access token

  # Reusable helper: logs in with the supplied credentials and returns the access token. Use with:
  #   * def session = call read('classpath:karate/helpers/login.feature') { email: '...', password: '...' }
  #   * def token = session.accessToken

  Background:
    * url apiV1

  Scenario: login
    Given path 'auth', 'login'
    And request { email: '#(email)', password: '#(password)' }
    When method post
    Then status 200
    * def accessToken = response.tokens.accessToken
