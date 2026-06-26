Feature: Authentication
  Registration, login, token refresh/rotation and /me — with the JWT/authz negatives that make up
  the "secure" half of SecureGate.

  Background:
    * url apiV1

  Scenario: registering a new user returns 201 with a user + tokens (contract)
    * def email = freshEmail()
    Given path 'auth', 'register'
    And request { email: '#(email)', password: 'Password123!', name: 'New User' }
    When method post
    Then status 201
    And match response.user contains { id: '#string', email: '#(email)', name: '#string', role: 'CUSTOMER', createdAt: '#string' }
    And match response.tokens contains { accessToken: '#string', refreshToken: '#string', tokenType: '#string', expiresIn: '#number' }

  Scenario: registering an already-taken email returns 409 EMAIL_TAKEN
    Given path 'auth', 'register'
    And request { email: '#(customerEmail)', password: 'Password123!', name: 'Dup' }
    When method post
    Then status 409
    And match response.error.code == 'EMAIL_TAKEN'

  Scenario: logging in with the right credentials returns tokens
    Given path 'auth', 'login'
    And request { email: '#(customerEmail)', password: '#(customerPassword)' }
    When method post
    Then status 200
    And match response.user.email == customerEmail
    And match response.tokens.accessToken == '#string'

  Scenario: a wrong password returns 401 INVALID_CREDENTIALS
    Given path 'auth', 'login'
    And request { email: '#(customerEmail)', password: 'wrong-password' }
    When method post
    Then status 401
    And match response.error.code == 'INVALID_CREDENTIALS'

  Scenario: a malformed email is rejected with 400 VALIDATION_ERROR
    Given path 'auth', 'login'
    And request { email: 'not-an-email', password: 'whatever' }
    When method post
    Then status 400
    And match response.error.code == 'VALIDATION_ERROR'

  Scenario: a refresh token rotates and the old token is then rejected (401 INVALID_TOKEN)
    * def user = call read('classpath:karate/helpers/register.feature')
    # First refresh: succeeds and rotates the token.
    Given path 'auth', 'refresh'
    And request { refreshToken: '#(user.refreshToken)' }
    When method post
    Then status 200
    And match response.accessToken == '#string'
    And match response.refreshToken == '#string'
    And match response.refreshToken != user.refreshToken
    # Reusing the original (now-revoked) refresh token must fail.
    Given path 'auth', 'refresh'
    And request { refreshToken: '#(user.refreshToken)' }
    When method post
    Then status 401
    And match response.error.code == 'INVALID_TOKEN'

  Scenario: GET /auth/me with a valid token returns the current user
    * def user = call read('classpath:karate/helpers/register.feature')
    Given path 'auth', 'me'
    And header Authorization = 'Bearer ' + user.accessToken
    When method get
    Then status 200
    And match response.user.id == user.userId
    And match response.user.email == user.email

  Scenario: GET /auth/me without a token returns 401 UNAUTHENTICATED
    Given path 'auth', 'me'
    When method get
    Then status 401
    And match response.error.code == 'UNAUTHENTICATED'

  Scenario: GET /auth/me with a tampered token returns 401
    * def session = call read('classpath:karate/helpers/login.feature') { email: '#(customerEmail)', password: '#(customerPassword)' }
    * def tampered = session.accessToken + 'x'
    Given path 'auth', 'me'
    And header Authorization = 'Bearer ' + tampered
    When method get
    Then status 401
