import os,secrets,hashlib
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / '.env')
from datetime import datetime,timedelta
from urllib.parse import urlencode
import httpx,jwt
from fastapi import APIRouter,HTTPException,Request
from fastapi.responses import RedirectResponse
from sqlalchemy import Column,DateTime,ForeignKey,Integer,String,UniqueConstraint
try:
 from backend.database import Base,SessionLocal,engine
 from backend.models import User
 from backend.auth_api import _hash_password,_session_response
except ImportError:
 from database import Base,SessionLocal,engine
 from models import User
 from auth_api import _hash_password,_session_response
router=APIRouter(prefix="/api/auth",tags=["social auth"])
FRONT=os.getenv("OAUTH_FRONTEND_URL","http://localhost:8443").rstrip("/")
BACK=os.getenv("OAUTH_BACKEND_URL","http://localhost:8000").rstrip("/")
COOKIE="vn_oauth_state"
CFG={"google":("GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET"),"facebook":("FACEBOOK_CLIENT_ID","FACEBOOK_CLIENT_SECRET"),"apple":("APPLE_CLIENT_ID","APPLE_CLIENT_SECRET"),"microsoft":("MICROSOFT_CLIENT_ID","MICROSOFT_CLIENT_SECRET"),"github":("GITHUB_CLIENT_ID","GITHUB_CLIENT_SECRET")}
AUTH={"google":"https://accounts.google.com/o/oauth2/v2/auth","facebook":"https://www.facebook.com/v22.0/dialog/oauth","apple":"https://appleid.apple.com/auth/authorize","microsoft":"https://login.microsoftonline.com/common/oauth2/v2.0/authorize","github":"https://github.com/login/oauth/authorize"}
TOK={"google":"https://oauth2.googleapis.com/token","facebook":"https://graph.facebook.com/v22.0/oauth/access_token","apple":"https://appleid.apple.com/auth/token","microsoft":"https://login.microsoftonline.com/common/oauth2/v2.0/token","github":"https://github.com/login/oauth/access_token"}
class Identity(Base):
 __tablename__="oauth_identities"; __table_args__=(UniqueConstraint("provider","subject",name="uq_oauth_provider_subject"),)
 id=Column(Integer,primary_key=True); user_id=Column(Integer,ForeignKey("users.id"),nullable=False,index=True); provider=Column(String(30),nullable=False); subject=Column(String(255),nullable=False); email=Column(String(254)); created_at=Column(DateTime,default=datetime.utcnow,nullable=False)
class Ticket(Base):
 __tablename__="oauth_login_tickets"
 id=Column(Integer,primary_key=True); ticket_hash=Column(String(64),unique=True,nullable=False,index=True); user_id=Column(Integer,ForeignKey("users.id"),nullable=False); expires_at=Column(DateTime,nullable=False)
class OAuthState(Base):
 __tablename__="oauth_login_states"
 id=Column(Integer,primary_key=True); state_hash=Column(String(64),unique=True,nullable=False,index=True); provider=Column(String(30),nullable=False); expires_at=Column(DateTime,nullable=False)
def conf(p):
 a,b=CFG[p]; client=os.getenv(a,"").strip(); secret=os.getenv(b,"").strip()
 if p=="apple": secret=all(os.getenv(k,"").strip() for k in ("APPLE_TEAM_ID","APPLE_KEY_ID","APPLE_PRIVATE_KEY"))
 return client,os.getenv(b,"").strip(),bool(client and secret)
@router.get("/providers")
def list_providers():
 return {"providers":[{"id":p,"name":p.title(),"configured":conf(p)[2]} for p in CFG]}
@router.get("/oauth/{provider}/start")
def start(provider:str):
 if provider not in CFG: raise HTTPException(404,"Unknown provider")
 client,secret,ready=conf(provider)
 if not ready: raise HTTPException(503,"Add this provider's credentials to the backend environment first.")
 red=os.getenv(provider.upper()+"_REDIRECT_URI",BACK+"/api/auth/oauth/"+provider+"/callback")
 state=secrets.token_urlsafe(32); Identity.__table__.create(bind=engine,checkfirst=True); Ticket.__table__.create(bind=engine,checkfirst=True); OAuthState.__table__.create(bind=engine,checkfirst=True); db=SessionLocal(); db.add(OAuthState(state_hash=hashlib.sha256(state.encode()).hexdigest(),provider=provider,expires_at=datetime.utcnow()+timedelta(minutes=10))); db.commit(); db.close(); scope={"google":"openid email profile","facebook":"email public_profile","apple":"name email","microsoft":"openid profile email User.Read","github":"read:user user:email"}[provider]
 q={"client_id":client,"redirect_uri":red,"response_type":"code","scope":scope,"state":state}
 if provider=="google": q["prompt"]="select_account"
 return RedirectResponse(AUTH[provider]+"?"+urlencode(q))
def apple_client_secret(client):
 now=datetime.utcnow(); key=os.getenv("APPLE_PRIVATE_KEY","").replace("\\n","\n")
 return jwt.encode({"iss":os.getenv("APPLE_TEAM_ID"),"iat":now,"exp":now+timedelta(days=150),"aud":"https://appleid.apple.com","sub":client},key,algorithm="ES256",headers={"kid":os.getenv("APPLE_KEY_ID")})
def get_identity(p,token,data):
 h={"Authorization":"Bearer "+token,"Accept":"application/json","User-Agent":"VisionaryNexus"}
 if p=="google":
  d=httpx.get("https://openidconnect.googleapis.com/v1/userinfo",headers=h,timeout=15).json()
  if not d.get("email_verified"): raise HTTPException(400,"Google email must be verified.")
  return str(d["sub"]),d.get("email"),d.get("name")
 if p=="facebook":
  d=httpx.get("https://graph.facebook.com/me?fields=id,name,email",headers=h,timeout=15).json()
  if not d.get("email"): raise HTTPException(400,"Facebook did not return an email.")
  return str(d["id"]),d["email"],d.get("name")
 if p=="github":
  d=httpx.get("https://api.github.com/user",headers=h,timeout=15).json()
  # Always use GitHub's email endpoint so the address is confirmed as verified.
  es=httpx.get("https://api.github.com/user/emails",headers=h,timeout=15)
  es.raise_for_status()
  email=next((x["email"] for x in es.json() if x.get("primary") and x.get("verified")),None)
  if not email: raise HTTPException(400,"Add and verify a primary email address in GitHub settings.")
  return str(d["id"]),email,d.get("name") or d.get("login")
 if p=="microsoft":
  d=httpx.get("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",headers=h,timeout=15).json(); email=d.get("mail") or d.get("userPrincipalName")
  if not email: raise HTTPException(400,"Microsoft did not return an email.")
  return str(d["id"]),email,d.get("displayName")
 ident=data.get("id_token")
 if not ident: raise HTTPException(400,"Apple did not return an identity token.")
 key=jwt.PyJWKClient("https://appleid.apple.com/auth/keys").get_signing_key_from_jwt(ident).key
 claims=jwt.decode(ident,key,algorithms=["RS256"],audience=os.getenv("APPLE_CLIENT_ID"),issuer="https://appleid.apple.com")
 return str(claims["sub"]),claims.get("email"),(claims.get("email") or "Apple User").split("@")[0]
def complete(p,code,state,request):
 if not state: raise HTTPException(400,"OAuth state validation failed. Please retry.")
 OAuthState.__table__.create(bind=engine,checkfirst=True)
 dbs=SessionLocal()
 try:
  saved=dbs.query(OAuthState).filter_by(state_hash=hashlib.sha256(state.encode()).hexdigest(),provider=p).first()
  if not saved or saved.expires_at<datetime.utcnow(): raise HTTPException(400,"OAuth state validation failed. Please retry.")
  dbs.delete(saved); dbs.commit()
 finally: dbs.close()
 client,secret,ready=conf(p)
 if not ready: raise HTTPException(503,"Provider is not configured.")
 red=os.getenv(p.upper()+"_REDIRECT_URI",BACK+"/api/auth/oauth/"+p+"/callback")
 try:
  body={"client_id":client,"client_secret":apple_client_secret(client) if p=="apple" else secret,"code":code,"redirect_uri":red,"grant_type":"authorization_code"}
  with httpx.Client(timeout=20) as c:
   r=c.post(TOK[p],data=body,headers={"Accept":"application/json"}); r.raise_for_status(); data=r.json()
   sub,email,name=get_identity(p,data.get("access_token",""),data)
 except HTTPException: raise
 except Exception: raise HTTPException(502,"Could not complete "+p.title()+" sign-in.")
 email=(email or "").strip().lower()
 if "@" not in email: raise HTTPException(400,"Provider did not return a usable email.")
 db=SessionLocal()
 try:
  linked=db.query(Identity).filter_by(provider=p,subject=sub).first()
  user=db.query(User).filter(User.id==linked.user_id).first() if linked else db.query(User).filter(User.email==email).first()
  if user and not linked and p!="github":
   raise HTTPException(409,"An account already uses this email. Sign in with that method first.")
  if not user:
   user=User(email=email,display_name=(name or email.split("@")[0])[:80],password_hash=_hash_password(secrets.token_urlsafe(48)),created_at=datetime.utcnow(),last_login_at=datetime.utcnow()); db.add(user); db.flush()
  # Link only after the provider has supplied a verified email address.
  if not linked:
   db.add(Identity(user_id=user.id,provider=p,subject=sub,email=email))
  user.last_login_at=datetime.utcnow(); raw=secrets.token_urlsafe(36); db.add(Ticket(ticket_hash=hashlib.sha256(raw.encode()).hexdigest(),user_id=user.id,expires_at=datetime.utcnow()+timedelta(minutes=2))); db.commit(); return raw
 finally: db.close()
def redirect(ticket=None,error=None):
 return RedirectResponse(FRONT+"/auth/callback"+("?oauth_ticket="+ticket if ticket else "?oauth_error="+error),status_code=303)
@router.get("/oauth/{provider}/callback")
def callback(provider:str,request:Request,code:str="",state:str="",error:str=""):
 if provider not in CFG: raise HTTPException(404,"Unknown provider")
 if error: return redirect(error="cancelled")
 if not code: raise HTTPException(400,"Missing authorization code")
 return redirect(ticket=complete(provider,code,state,request))
@router.post("/oauth/apple/callback")
async def apple_callback(request:Request):
 f=await request.form()
 if f.get("error"): return redirect(error="cancelled")
 return redirect(ticket=complete("apple",str(f.get("code","")),str(f.get("state","")),request))
@router.post("/oauth/exchange")
def exchange(payload:dict):
 raw=str(payload.get("ticket",""))
 if len(raw)<30: raise HTTPException(400,"Invalid ticket")
 db=SessionLocal()
 try:
  t=db.query(Ticket).filter_by(ticket_hash=hashlib.sha256(raw.encode()).hexdigest()).first()
  if not t or t.expires_at<datetime.utcnow(): raise HTTPException(401,"Sign-in ticket expired.")
  user=db.query(User).filter(User.id==t.user_id).first(); db.delete(t); db.commit()
  if not user: raise HTTPException(401,"Account not found")
  return _session_response(user)
 finally: db.close()
