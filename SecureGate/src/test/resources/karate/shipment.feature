Feature: Shipments
  Create / read / list shipments, plus the authn and owner-scoped authz negatives.

  Background:
    * url apiV1
    * def newShipment = read('classpath:karate/data/shipment.json')
    * def TRACKING_REGEX = '^PTY-\\d{4}-\\d{6}-\\d$'

  Scenario: a signed-in customer can create a shipment (201, CREATED, contract)
    * def user = call read('classpath:karate/helpers/register.feature')
    Given path 'shipments'
    And header Authorization = 'Bearer ' + user.accessToken
    And request newShipment
    When method post
    Then status 201
    And match response contains { id: '#string', trackingCode: '#string', status: 'CREATED', serviceLevel: '#string', priceCents: '#number', currency: 'USD', createdAt: '#string', origin: '#object', destination: '#object', parcel: '#object', events: '#array' }
    And match response.trackingCode == '#regex ' + TRACKING_REGEX

  Scenario: a customer can read back and list their own shipment
    * def user = call read('classpath:karate/helpers/register.feature')
    Given path 'shipments'
    And header Authorization = 'Bearer ' + user.accessToken
    And request newShipment
    When method post
    Then status 201
    * def id = response.id

    Given path 'shipments', id
    And header Authorization = 'Bearer ' + user.accessToken
    When method get
    Then status 200
    And match response.id == id

    Given path 'shipments'
    And header Authorization = 'Bearer ' + user.accessToken
    When method get
    Then status 200
    And match response.page == 1
    And match response.data[*].id contains id

  Scenario: a customer cannot read another customer's shipment (404, owner-scoped)
    * def owner = call read('classpath:karate/helpers/register.feature')
    Given path 'shipments'
    And header Authorization = 'Bearer ' + owner.accessToken
    And request newShipment
    When method post
    Then status 201
    * def id = response.id

    * def intruder = call read('classpath:karate/helpers/register.feature')
    Given path 'shipments', id
    And header Authorization = 'Bearer ' + intruder.accessToken
    When method get
    Then status 404

  Scenario: creating a shipment without a token returns 401 UNAUTHENTICATED
    Given path 'shipments'
    And request newShipment
    When method post
    Then status 401
    And match response.error.code == 'UNAUTHENTICATED'

  Scenario: a customer cannot register a tracking event (403 FORBIDDEN — staff only)
    * def user = call read('classpath:karate/helpers/register.feature')
    Given path 'shipments'
    And header Authorization = 'Bearer ' + user.accessToken
    And request newShipment
    When method post
    Then status 201
    * def id = response.id

    Given path 'shipments', id, 'events'
    And header Authorization = 'Bearer ' + user.accessToken
    And request { status: 'LABEL_PAID' }
    When method post
    Then status 403
    And match response.error.code == 'FORBIDDEN'
