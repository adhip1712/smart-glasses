import json
import urllib.parse
import backend.api as api

city_result = {"display_name": "Bengaluru, Karnataka, India", "lat": "12.9716", "lon": "77.5946", "class": "boundary", "type": "administrative"}
airport_result = {"display_name": "Kempegowda International Airport, Bengaluru, Karnataka, India", "lat": "13.1986", "lon": "77.7066", "class": "aeroway", "type": "aerodrome"}

class FakeResponse:
    def __init__(self, payload):
        self.payload = payload
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def read(self):
        return self.payload

class R:
    def __init__(self, url):
        self.full_url = url

api.NAVIGATION_BASE_URL = 'https://nominatim.openstreetmap.org'

def fake_urlopen(*args, **kwargs):
    req = args[0]
    qs = req.full_url.split('q=')[1].split('&')[0]
    print('RAW Q:', qs)
    decoded = urllib.parse.unquote_plus(qs)
    print('DECODED:', decoded)
    payload = json.dumps([airport_result, city_result] if decoded.lower() == 'bengaluru airport' else [city_result]).encode('utf-8')
    return FakeResponse(payload)

api.Request = lambda u, headers=None: R(u)
api.urlopen = fake_urlopen

print('matches airport?', api.RealNavigationProvider._query_keyword_matches(airport_result, 'Bengaluru airport'))
print('matches city?', api.RealNavigationProvider._query_keyword_matches(city_result, 'Bengaluru airport'))
print('search:', api.RealNavigationProvider().search('Bengaluru airport'))
print('city search:', api.RealNavigationProvider().search('bengalore'))
