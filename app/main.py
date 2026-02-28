from __future__ import annotations

import io
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import pandas as pd
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")
ACCESS_TOKEN_MINUTES = int(os.getenv("ACCESS_TOKEN_MINUTES", "30"))
REFRESH_TOKEN_DAYS = int(os.getenv("REFRESH_TOKEN_DAYS", "7"))
JWT_SECRET = os.getenv("JWT_SECRET", "change_me_super_secret")
JWT_ALGORITHM = "HS256"

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    uploads: Mapped[list[AccountingRecord]] = relationship(back_populates="owner")


class AccountingRecord(Base):
    __tablename__ = "accounting_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    date: Mapped[datetime.date] = mapped_column(Date, index=True)
    category: Mapped[str] = mapped_column(String(80), index=True)
    subcategory: Mapped[str] = mapped_column(String(80), index=True)
    description: Mapped[str] = mapped_column(String(255))
    flow_type: Mapped[str] = mapped_column(String(20), index=True)
    amount: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    owner: Mapped[User] = relationship(back_populates="uploads")


engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

app = FastAPI(title="Contabilidad Dinámica")
app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def set_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store"
    return response


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def create_token(subject: str, token_type: str, expires_delta: timedelta) -> str:
    expire = datetime.now(timezone.utc) + expires_delta
    payload = {"sub": subject, "type": token_type, "exp": expire}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str, expected_type: str) -> str:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido") from exc
    if payload.get("type") != expected_type:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Tipo de token inválido")
    subject = payload.get("sub")
    if not subject:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token sin subject")
    return subject


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
    bearer: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> User:
    raw_token = request.cookies.get("access_token")
    if not raw_token and bearer:
        raw_token = bearer.credentials
    if not raw_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No autenticado")
    username = decode_token(raw_token, "access")
    user = db.scalar(select(User).where(User.username == username))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario no encontrado")
    return user


def set_auth_cookies(response: JSONResponse, username: str) -> None:
    access = create_token(username, "access", timedelta(minutes=ACCESS_TOKEN_MINUTES))
    refresh = create_token(username, "refresh", timedelta(days=REFRESH_TOKEN_DAYS))
    response.set_cookie("access_token", access, httponly=True, secure=False, samesite="strict", max_age=ACCESS_TOKEN_MINUTES * 60)
    response.set_cookie("refresh_token", refresh, httponly=True, secure=False, samesite="strict", max_age=REFRESH_TOKEN_DAYS * 24 * 3600)


def clear_auth_cookies(response: JSONResponse) -> None:
    response.delete_cookie("access_token")
    response.delete_cookie("refresh_token")


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)


@app.get("/", response_class=HTMLResponse)
def root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/api/auth/register")
def register(
    username: str = Form(...),
    full_name: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    if len(password) < 10:
        raise HTTPException(status_code=400, detail="La contraseña debe tener al menos 10 caracteres")
    exists = db.scalar(select(User).where(User.username == username.lower()))
    if exists:
        raise HTTPException(status_code=400, detail="El usuario ya existe")
    user = User(username=username.lower(), full_name=full_name, password_hash=hash_password(password))
    db.add(user)
    db.commit()
    return {"message": "Usuario creado"}


@app.post("/api/auth/login")
def login(username: str = Form(...), password: str = Form(...), db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == username.lower()))
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Credenciales inválidas")
    response = JSONResponse({"message": "Login exitoso", "full_name": user.full_name})
    set_auth_cookies(response, user.username)
    return response


@app.post("/api/auth/refresh")
def refresh(request: Request):
    token = request.cookies.get("refresh_token")
    if not token:
        raise HTTPException(status_code=401, detail="Refresh token no encontrado")
    username = decode_token(token, "refresh")
    response = JSONResponse({"message": "Token actualizado"})
    set_auth_cookies(response, username)
    return response


@app.post("/api/auth/logout")
def logout():
    response = JSONResponse({"message": "Logout exitoso"})
    clear_auth_cookies(response)
    return response


@app.get("/api/me")
def me(user: User = Depends(get_current_user)):
    return {"username": user.username, "full_name": user.full_name}


@app.post("/api/data/upload")
def upload_excel(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not file.filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Archivo no soportado")

    content = file.file.read()
    dataframe = pd.read_excel(io.BytesIO(content))
    required_columns = {"fecha", "categoria", "subcategoria", "descripcion", "tipo", "monto"}
    missing = required_columns.difference(set(c.lower() for c in dataframe.columns))
    if missing:
        raise HTTPException(status_code=400, detail=f"Faltan columnas: {', '.join(sorted(missing))}")

    normalized = {c.lower(): c for c in dataframe.columns}
    created = 0
    for _, row in dataframe.iterrows():
        try:
            flow_type = str(row[normalized["tipo"]]).strip().lower()
            if flow_type not in {"ingreso", "egreso"}:
                continue
            record = AccountingRecord(
                owner_id=user.id,
                date=pd.to_datetime(row[normalized["fecha"]]).date(),
                category=str(row[normalized["categoria"]]).strip(),
                subcategory=str(row[normalized["subcategoria"]]).strip(),
                description=str(row[normalized["descripcion"]]).strip(),
                flow_type=flow_type,
                amount=float(row[normalized["monto"]]),
            )
        except Exception:
            continue
        db.add(record)
        created += 1

    db.commit()
    return {"message": "Carga completada", "rows_inserted": created}


@app.get("/api/data/records")
def records(
    category: Optional[str] = Query(default=None),
    flow_type: Optional[str] = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=200, le=1000),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = select(AccountingRecord).where(AccountingRecord.owner_id == user.id)
    if category:
        query = query.where(AccountingRecord.category == category)
    if flow_type:
        query = query.where(AccountingRecord.flow_type == flow_type)
    if date_from:
        query = query.where(AccountingRecord.date >= datetime.fromisoformat(date_from).date())
    if date_to:
        query = query.where(AccountingRecord.date <= datetime.fromisoformat(date_to).date())
    if search:
        query = query.where(AccountingRecord.description.ilike(f"%{search}%"))

    query = query.order_by(AccountingRecord.date.desc()).limit(limit)
    result = db.scalars(query).all()

    return [
        {
            "id": item.id,
            "fecha": item.date.isoformat(),
            "categoria": item.category,
            "subcategoria": item.subcategory,
            "descripcion": item.description,
            "tipo": item.flow_type,
            "monto": round(item.amount, 2),
        }
        for item in result
    ]


@app.get("/api/data/summary")
def summary(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    by_category = db.execute(
        select(AccountingRecord.category, func.sum(AccountingRecord.amount))
        .where(AccountingRecord.owner_id == user.id)
        .group_by(AccountingRecord.category)
        .order_by(func.sum(AccountingRecord.amount).desc())
    ).all()

    by_month = db.execute(
        select(func.strftime("%Y-%m", AccountingRecord.date), func.sum(AccountingRecord.amount))
        .where(AccountingRecord.owner_id == user.id)
        .group_by(func.strftime("%Y-%m", AccountingRecord.date))
        .order_by(func.strftime("%Y-%m", AccountingRecord.date))
    ).all()

    by_flow = db.execute(
        select(AccountingRecord.flow_type, func.sum(AccountingRecord.amount))
        .where(AccountingRecord.owner_id == user.id)
        .group_by(AccountingRecord.flow_type)
    ).all()

    return {
        "by_category": [{"label": row[0], "value": float(row[1])} for row in by_category],
        "by_month": [{"label": row[0], "value": float(row[1])} for row in by_month],
        "by_flow": [{"label": row[0], "value": float(row[1])} for row in by_flow],
    }
