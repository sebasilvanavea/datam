from __future__ import annotations

import io
import os
import re
import secrets
import unicodedata
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

import pandas as pd
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, create_engine, delete, extract, func, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")
UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", "app/uploads"))
ACCESS_TOKEN_MINUTES = int(os.getenv("ACCESS_TOKEN_MINUTES", "30"))
REFRESH_TOKEN_DAYS = int(os.getenv("REFRESH_TOKEN_DAYS", "7"))
JWT_SECRET = os.getenv("JWT_SECRET", "change_me_super_secret")
JWT_ALGORITHM = "HS256"
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "strict").lower()
COOKIE_DOMAIN = os.getenv("COOKIE_DOMAIN")
CSRF_COOKIE_NAME = "csrf_token"
CSRF_HEADER_NAME = "x-csrf-token"
CSRF_EXEMPT_PATHS = {
    "/api/auth/register",
    "/api/auth/login",
    "/api/auth/refresh",
}
LOGIN_RATE_LIMIT_MAX_ATTEMPTS = int(os.getenv("LOGIN_RATE_LIMIT_MAX_ATTEMPTS", "10"))
LOGIN_RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("LOGIN_RATE_LIMIT_WINDOW_SECONDS", "300"))
CORS_ALLOW_ORIGINS = [
    item.strip()
    for item in os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000").split(",")
    if item.strip()
]

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)
login_attempts_by_ip: dict[str, list[datetime]] = {}


def add_cors_headers(response: JSONResponse, request: Request) -> JSONResponse:
    origin = request.headers.get("origin")
    if origin and origin in CORS_ALLOW_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Vary"] = "Origin"
    return response


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    companies: Mapped[list[Company]] = relationship(back_populates="owner")
    vaults: Mapped[list[Vault]] = relationship(back_populates="owner")
    uploads: Mapped[list[AccountingRecord]] = relationship(back_populates="owner")
    upload_batches: Mapped[list[UploadBatch]] = relationship(back_populates="owner")


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(140), index=True)
    legal_name: Mapped[str] = mapped_column(String(180), default="")
    tax_id: Mapped[str] = mapped_column(String(80), default="")
    business_line: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    owner: Mapped[User] = relationship(back_populates="companies")
    vaults: Mapped[list[Vault]] = relationship(back_populates="company")
    records: Mapped[list[AccountingRecord]] = relationship(back_populates="company")
    upload_batches: Mapped[list[UploadBatch]] = relationship(back_populates="company")


class Vault(Base):
    __tablename__ = "vaults"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    name: Mapped[str] = mapped_column(String(140), index=True)
    period_type: Mapped[str] = mapped_column(String(30), default="custom")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    owner: Mapped[User] = relationship(back_populates="vaults")
    company: Mapped[Company] = relationship(back_populates="vaults")
    records: Mapped[list[AccountingRecord]] = relationship(back_populates="vault")
    upload_batches: Mapped[list[UploadBatch]] = relationship(back_populates="vault")


class UploadBatch(Base):
    __tablename__ = "upload_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    company_id: Mapped[Optional[int]] = mapped_column(ForeignKey("companies.id"), index=True, nullable=True)
    vault_id: Mapped[Optional[int]] = mapped_column(ForeignKey("vaults.id"), index=True, nullable=True)
    original_filename: Mapped[str] = mapped_column(String(255))
    stored_path: Mapped[str] = mapped_column(String(400))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    period_label: Mapped[str] = mapped_column(String(30), default="")
    records_inserted: Mapped[int] = mapped_column(Integer, default=0)
    duplicates_skipped: Mapped[int] = mapped_column(Integer, default=0)

    owner: Mapped[User] = relationship(back_populates="upload_batches")
    company: Mapped[Optional[Company]] = relationship(back_populates="upload_batches")
    vault: Mapped[Optional[Vault]] = relationship(back_populates="upload_batches")
    records: Mapped[list[AccountingRecord]] = relationship(back_populates="upload_batch")


class AccountingRecord(Base):
    __tablename__ = "accounting_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    company_id: Mapped[Optional[int]] = mapped_column(ForeignKey("companies.id"), index=True, nullable=True)
    vault_id: Mapped[Optional[int]] = mapped_column(ForeignKey("vaults.id"), index=True, nullable=True)
    upload_batch_id: Mapped[Optional[int]] = mapped_column(ForeignKey("upload_batches.id"), index=True, nullable=True)
    date: Mapped[datetime.date] = mapped_column(Date, index=True)
    month: Mapped[str] = mapped_column(String(20), index=True, default="")
    account: Mapped[str] = mapped_column(String(120), index=True, default="General")
    category: Mapped[str] = mapped_column(String(80), index=True)
    subcategory: Mapped[str] = mapped_column(String(80), index=True)
    project: Mapped[str] = mapped_column(String(120), index=True, default="Sin proyecto")
    project_code: Mapped[str] = mapped_column(String(80), index=True, default="")
    counterparty: Mapped[str] = mapped_column(String(160), default="")
    description: Mapped[str] = mapped_column(String(255))
    document_type: Mapped[str] = mapped_column(String(80), default="")
    document_number: Mapped[str] = mapped_column(String(80), default="")
    flow_type: Mapped[str] = mapped_column(String(20), index=True)
    verified: Mapped[str] = mapped_column(String(40), index=True, default="")
    comments: Mapped[str] = mapped_column(String(255), default="")
    amount: Mapped[float] = mapped_column(Float)
    balance: Mapped[float] = mapped_column(Float, default=0.0)
    source_filename: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    owner: Mapped[User] = relationship(back_populates="uploads")
    company: Mapped[Optional[Company]] = relationship(back_populates="records")
    vault: Mapped[Optional[Vault]] = relationship(back_populates="records")
    upload_batch: Mapped[Optional[UploadBatch]] = relationship(back_populates="records")


engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    ensure_schema_evolution()
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    yield


def ensure_schema_evolution() -> None:
    Base.metadata.create_all(bind=engine)


ensure_schema_evolution()


app = FastAPI(title="Contabilidad Dinámica", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def set_security_headers(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if request.url.path not in CSRF_EXEMPT_PATHS:
            csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)
            csrf_header = request.headers.get(CSRF_HEADER_NAME)
            if not csrf_cookie or not csrf_header or not secrets.compare_digest(csrf_cookie, csrf_header):
                return add_cors_headers(
                    JSONResponse(status_code=403, content={"detail": "CSRF token inválido"}),
                    request,
                )

    response = await call_next(request)
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';"
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


def normalize_column_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    normalized = normalized.strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "_", normalized)
    return normalized.strip("_")


def parse_amount(value) -> float:
    if pd.isna(value):
        raise ValueError("Monto vacío")
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(" ", "")
    text = re.sub(r"[^0-9,.-]", "", text)
    if not text:
        raise ValueError("Monto inválido")
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        text = text.replace(".", "").replace(",", ".")
    return float(text)


def parse_excel_date(value) -> date:
    if pd.isna(value):
        raise ValueError("Fecha vacía")
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value

    text_value = str(value).strip()
    if not text_value:
        raise ValueError("Fecha inválida")

    iso_like = re.match(r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}$", text_value)
    if iso_like:
        return datetime.fromisoformat(text_value.replace("/", "-")).date()

    parsed = pd.to_datetime(value, dayfirst=True, errors="coerce")
    if pd.isna(parsed):
        parsed = pd.to_datetime(value, dayfirst=False, errors="raise")
    return parsed.date()


def detect_header_row(raw_dataframe: pd.DataFrame) -> Optional[int]:
    max_rows = min(len(raw_dataframe), 40)
    for row_index in range(max_rows):
        row_values = {
            normalize_column_name(str(value))
            for value in raw_dataframe.iloc[row_index].tolist()
            if pd.notna(value) and str(value).strip()
        }
        if "fecha" in row_values and (
            "tipo" in row_values or "tipo_de_movimiento" in row_values
        ) and (
            "categoria" in row_values
            or "linea_de_negocio" in row_values
            or "categoria_" in row_values
        ):
            return row_index
    return None


def extract_sheet_as_table(raw_dataframe: pd.DataFrame) -> Optional[pd.DataFrame]:
    header_row = detect_header_row(raw_dataframe)
    if header_row is None:
        return None

    header = [str(value).strip() if pd.notna(value) else "" for value in raw_dataframe.iloc[header_row].tolist()]
    table = raw_dataframe.iloc[header_row + 1 :].copy()
    table.columns = header
    table = table.dropna(how="all")
    table = table.loc[:, [column for column in table.columns if str(column).strip()]]
    return table


def apply_record_filters(
    query,
    category: Optional[str],
    subcategory: Optional[str],
    project: Optional[str],
    account: Optional[str],
    project_code: Optional[str],
    year: Optional[str],
    month_number: Optional[str],
    flow_type: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
    search: Optional[str],
):
    if category:
        query = query.where(AccountingRecord.category == category)
    if subcategory:
        query = query.where(AccountingRecord.subcategory == subcategory)
    if project:
        query = query.where(AccountingRecord.project == project)
    if account:
        query = query.where(AccountingRecord.account == account)
    if project_code:
        query = query.where(AccountingRecord.project_code == project_code)
    if year:
        year_value = int(year)
        query = query.where(extract("year", AccountingRecord.date) == year_value)
    if month_number:
        month_value = int(month_number)
        query = query.where(extract("month", AccountingRecord.date) == month_value)
    if flow_type:
        query = query.where(AccountingRecord.flow_type == flow_type)
    if date_from:
        query = query.where(AccountingRecord.date >= datetime.fromisoformat(date_from).date())
    if date_to:
        query = query.where(AccountingRecord.date <= datetime.fromisoformat(date_to).date())
    if search:
        search_term = f"%{search.strip()}%"
        query = query.where(
            AccountingRecord.description.ilike(search_term)
            | AccountingRecord.category.ilike(search_term)
            | AccountingRecord.subcategory.ilike(search_term)
            | AccountingRecord.project.ilike(search_term)
            | AccountingRecord.account.ilike(search_term)
            | AccountingRecord.project_code.ilike(search_term)
            | AccountingRecord.counterparty.ilike(search_term)
            | AccountingRecord.document_number.ilike(search_term)
        )
    return query


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


def resolve_company(
    user: User,
    db: Session,
    company_id: Optional[int],
) -> Company:
    if company_id is not None:
        company = db.scalar(select(Company).where(Company.id == company_id, Company.owner_id == user.id))
        if not company:
            raise HTTPException(status_code=404, detail="Compañía no encontrada")
        return company

    company = db.scalar(select(Company).where(Company.owner_id == user.id).order_by(Company.id.asc()))
    if company:
        return company

    company = Company(owner_id=user.id, name="Empresa principal")
    db.add(company)
    db.commit()
    db.refresh(company)
    return company


def resolve_vault(
    user: User,
    db: Session,
    company: Company,
    vault_id: Optional[int],
) -> Vault:
    if vault_id is not None:
        vault = db.scalar(
            select(Vault).where(
                Vault.id == vault_id,
                Vault.owner_id == user.id,
                Vault.company_id == company.id,
            )
        )
        if not vault:
            raise HTTPException(status_code=404, detail="Vault no encontrado")
        return vault

    vault = db.scalar(
        select(Vault)
        .where(Vault.owner_id == user.id, Vault.company_id == company.id)
        .order_by(Vault.id.asc())
    )
    if vault:
        return vault

    vault = Vault(owner_id=user.id, company_id=company.id, name="General", period_type="custom")
    db.add(vault)
    db.commit()
    db.refresh(vault)
    return vault


def normalize_text_value(value: object, fallback: str = "") -> str:
    if value is None or pd.isna(value):
        return fallback
    text = str(value).strip()
    if not text or text.lower() == "nan":
        return fallback
    return text


def build_record_fingerprint(
    owner_id: int,
    parsed_date,
    account: str,
    category: str,
    subcategory: str,
    project: str,
    project_code: str,
    description: str,
    flow_type: str,
    amount: float,
    document_number: str,
) -> tuple:
    return (
        owner_id,
        parsed_date.isoformat(),
        account.lower(),
        category.lower(),
        subcategory.lower(),
        project.lower(),
        project_code.lower(),
        description.lower(),
        flow_type,
        round(amount, 2),
        document_number.lower(),
    )


def set_auth_cookies(response: JSONResponse, username: str) -> None:
    access = create_token(username, "access", timedelta(minutes=ACCESS_TOKEN_MINUTES))
    refresh = create_token(username, "refresh", timedelta(days=REFRESH_TOKEN_DAYS))
    csrf_token = secrets.token_urlsafe(32)
    response.set_cookie(
        "access_token",
        access,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        domain=COOKIE_DOMAIN,
        max_age=ACCESS_TOKEN_MINUTES * 60,
    )
    response.set_cookie(
        "refresh_token",
        refresh,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        domain=COOKIE_DOMAIN,
        max_age=REFRESH_TOKEN_DAYS * 24 * 3600,
    )
    response.set_cookie(
        CSRF_COOKIE_NAME,
        csrf_token,
        httponly=False,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        domain=COOKIE_DOMAIN,
        max_age=REFRESH_TOKEN_DAYS * 24 * 3600,
    )


def clear_auth_cookies(response: JSONResponse) -> None:
    response.delete_cookie("access_token")
    response.delete_cookie("refresh_token")
    response.delete_cookie(CSRF_COOKIE_NAME)


def get_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def is_rate_limited(ip_address: str, now: datetime) -> bool:
    window_start = now - timedelta(seconds=LOGIN_RATE_LIMIT_WINDOW_SECONDS)
    attempts = [timestamp for timestamp in login_attempts_by_ip.get(ip_address, []) if timestamp >= window_start]
    login_attempts_by_ip[ip_address] = attempts
    return len(attempts) >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS


def register_failed_attempt(ip_address: str, now: datetime) -> None:
    attempts = login_attempts_by_ip.get(ip_address, [])
    attempts.append(now)
    login_attempts_by_ip[ip_address] = attempts


def clear_failed_attempts(ip_address: str) -> None:
    login_attempts_by_ip.pop(ip_address, None)


@app.get("/")
def root():
    return {"status": "ok", "service": "datam-backend"}


@app.post("/api/auth/register")
def register(
    username: str = Form(...),
    full_name: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    if len(password) < 10:
        raise HTTPException(status_code=400, detail="La contraseña debe tener al menos 10 caracteres")
    if len(password.encode("utf-8")) > 72:
        raise HTTPException(status_code=400, detail="La contraseña no debe superar 72 bytes")
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{3,80}", username):
        raise HTTPException(status_code=400, detail="Usuario inválido: usa solo letras, números, guion, punto o guion bajo")
    exists = db.scalar(select(User).where(User.username == username.lower()))
    if exists:
        raise HTTPException(status_code=400, detail="El usuario ya existe")
    user = User(username=username.lower(), full_name=full_name, password_hash=hash_password(password))
    db.add(user)
    db.flush()
    db.add(Company(owner_id=user.id, name="Empresa principal"))
    db.commit()
    return {"message": "Usuario creado"}


@app.post("/api/auth/login")
def login(request: Request, username: str = Form(...), password: str = Form(...), db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    ip_address = get_client_ip(request)
    if is_rate_limited(ip_address, now):
        raise HTTPException(status_code=429, detail="Demasiados intentos. Intenta nuevamente en unos minutos")
    if len(password.encode("utf-8")) > 72:
        register_failed_attempt(ip_address, now)
        raise HTTPException(status_code=401, detail="Credenciales inválidas")
    user = db.scalar(select(User).where(User.username == username.lower()))
    if not user or not verify_password(password, user.password_hash):
        register_failed_attempt(ip_address, now)
        raise HTTPException(status_code=401, detail="Credenciales inválidas")
    response = JSONResponse({"message": "Login exitoso", "full_name": user.full_name})
    clear_failed_attempts(ip_address)
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


@app.get("/api/companies")
def list_companies(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(Company)
        .where(Company.owner_id == user.id)
        .order_by(Company.created_at.asc())
    ).all()
    return [
        {
            "id": item.id,
            "name": item.name,
            "legal_name": item.legal_name,
            "tax_id": item.tax_id,
            "business_line": item.business_line,
        }
        for item in rows
    ]


@app.post("/api/companies")
def create_company(
    name: str = Form(...),
    legal_name: str = Form(default=""),
    tax_id: str = Form(default=""),
    business_line: str = Form(default=""),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    clean_name = name.strip()
    if len(clean_name) < 2:
        raise HTTPException(status_code=400, detail="Nombre de compañía inválido")
    exists = db.scalar(select(Company).where(Company.owner_id == user.id, Company.name == clean_name))
    if exists:
        raise HTTPException(status_code=400, detail="Ya existe una compañía con ese nombre")
    company = Company(
        owner_id=user.id,
        name=clean_name,
        legal_name=legal_name.strip(),
        tax_id=tax_id.strip(),
        business_line=business_line.strip(),
    )
    db.add(company)
    db.flush()
    default_vault = Vault(owner_id=user.id, company_id=company.id, name="General", period_type="custom")
    db.add(default_vault)
    db.commit()
    db.refresh(company)
    return {
        "id": company.id,
        "name": company.name,
        "legal_name": company.legal_name,
        "tax_id": company.tax_id,
        "business_line": company.business_line,
    }


@app.get("/api/vaults")
def list_vaults(
    company_id: Optional[int] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    rows = db.scalars(
        select(Vault)
        .where(Vault.owner_id == user.id)
        .where(Vault.company_id == company.id)
        .order_by(Vault.created_at.desc())
    ).all()
    return [
        {
            "id": item.id,
            "name": item.name,
            "period_type": item.period_type,
            "created_at": item.created_at.isoformat(),
        }
        for item in rows
    ]


@app.post("/api/vaults")
def create_vault(
    company_id: Optional[int] = Query(default=None),
    name: str = Form(...),
    period_type: str = Form(default="custom"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    clean_name = name.strip()
    clean_type = period_type.strip().lower() or "custom"
    allowed_types = {"mensual", "trimestral", "anual", "custom"}
    if clean_type not in allowed_types:
        clean_type = "custom"
    if len(clean_name) < 2:
        raise HTTPException(status_code=400, detail="Nombre de vault inválido")

    exists = db.scalar(
        select(Vault).where(
            Vault.owner_id == user.id,
            Vault.company_id == company.id,
            Vault.name == clean_name,
        )
    )
    if exists:
        raise HTTPException(status_code=400, detail="Ya existe un vault con ese nombre")

    vault = Vault(owner_id=user.id, company_id=company.id, name=clean_name, period_type=clean_type)
    db.add(vault)
    db.commit()
    db.refresh(vault)
    return {
        "id": vault.id,
        "name": vault.name,
        "period_type": vault.period_type,
        "created_at": vault.created_at.isoformat(),
    }


@app.post("/api/data/upload")
def upload_excel(
    enforce_period_check: bool = Query(default=False),
    allow_period_update: bool = Query(default=False),
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not file.filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Archivo no soportado")

    content = file.file.read()
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    user_upload_dir = UPLOADS_DIR / str(user.id)
    user_upload_dir.mkdir(parents=True, exist_ok=True)
    safe_name = re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename)
    file_token = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S") + "_" + uuid4().hex[:8]
    stored_filename = f"{file_token}_{safe_name}"
    stored_path = user_upload_dir / stored_filename
    stored_path.write_bytes(content)

    sheet_frames = pd.read_excel(io.BytesIO(content), sheet_name=None, header=None)

    aliases = {
        "mes": ["mes", "month"],
        "fecha": ["fecha", "date", "fec"],
        "cuenta": ["cuenta", "account"],
        "categoria": ["categoria", "category", "linea_de_negocio", "categoria_", "linea_de_negocios"],
        "subcategoria": ["subcategoria", "sub_category", "subcategory", "subtipo_de_movimiento", "etapa_de_linea_de_negocio"],
        "codigo_proyecto": ["codigo_de_proyecto", "codigo_proyecto", "project_code", "cod_proyecto"],
        "proyecto": ["proyecto", "project", "nombre_de_proyecto", "nombre_proyecto", "proyecto_nombre", "obra", "item"],
        "emisor_receptor": ["emisor_receptor", "emisor___receptor", "emisor_o_receptor", "counterparty"],
        "descripcion": ["descripcion", "description", "detalle", "concepto"],
        "tipo_documento": ["tipo_de_documento", "tipo_documento", "document_type"],
        "numero_documento": ["numero_de_documento", "numero_documento", "document_number", "n_documento"],
        "tipo": ["tipo", "type", "flujo", "flow_type", "tipo_de_movimiento"],
        "monto": ["monto", "amount", "valor", "importe"],
        "entrada_neta": ["entradas_netas", "entrada_neta", "entrada", "entradas_brutas"],
        "salida_neta": ["salida_neta", "salida", "salidas_netas", "salidas_brutas"],
        "verificado": ["verificado", "checked", "validado"],
        "comentarios": ["comentarios", "comentario", "comments", "observaciones"],
        "saldo": ["saldo", "balance"],
    }
    flow_aliases = {"ingreso": "ingreso", "egreso": "egreso", "entrada": "ingreso", "salida": "egreso"}

    prepared_frames: list[tuple[pd.DataFrame, dict[str, str]]] = []

    for raw_sheet in sheet_frames.values():
        dataframe = extract_sheet_as_table(raw_sheet)
        if dataframe is None or dataframe.empty:
            continue

        normalized_to_original = {normalize_column_name(str(c)): c for c in dataframe.columns}
        column_map = {}
        for canonical, candidates in aliases.items():
            matched = next((candidate for candidate in candidates if candidate in normalized_to_original), None)
            if matched:
                column_map[canonical] = normalized_to_original[matched]

        mandatory = {"fecha", "categoria", "tipo"}
        if not mandatory.issubset(set(column_map.keys())):
            continue

        has_amount = "monto" in column_map or ("entrada_neta" in column_map and "salida_neta" in column_map)
        if not has_amount:
            continue

        prepared_frames.append((dataframe, column_map))

    batch = UploadBatch(
        owner_id=user.id,
        company_id=company.id,
        vault_id=vault.id,
        original_filename=file.filename,
        stored_path=str(stored_path.relative_to(Path.cwd())) if stored_path.is_absolute() else str(stored_path),
    )
    db.add(batch)
    db.flush()

    created = 0
    duplicates = 0
    replaced_rows = 0
    header_found = False

    for dataframe, column_map in prepared_frames:

        header_found = True

        period_samples: list[str] = []

        detected_period = None
        detected_month_start: Optional[date] = None
        detected_next_month_start: Optional[date] = None
        for _, row in dataframe.iterrows():
            try:
                flow_raw = str(row[column_map["tipo"]]).strip().lower()
                flow_type = flow_aliases.get(flow_raw)
                if flow_type not in {"ingreso", "egreso"}:
                    continue

                if "monto" in column_map:
                    _ = parse_amount(row[column_map["monto"]])
                elif flow_type == "ingreso":
                    _ = parse_amount(row[column_map["entrada_neta"]])
                else:
                    _ = parse_amount(row[column_map["salida_neta"]])

                parsed_date = parse_excel_date(row[column_map["fecha"]])
                detected_month_start = parsed_date.replace(day=1)
                detected_next_month_start = (
                    date(parsed_date.year + 1, 1, 1)
                    if parsed_date.month == 12
                    else date(parsed_date.year, parsed_date.month + 1, 1)
                )
                month_column = column_map.get("mes")
                detected_period = normalize_text_value(row[month_column], parsed_date.strftime("%Y-%m")) if month_column else parsed_date.strftime("%Y-%m")
                if detected_period:
                    break
            except Exception:
                continue

        if detected_period:
            existing_period_batch = db.scalar(
                select(UploadBatch)
                .where(
                    UploadBatch.owner_id == user.id,
                    UploadBatch.company_id == company.id,
                    UploadBatch.vault_id == vault.id,
                    UploadBatch.period_label == detected_period,
                )
                .order_by(UploadBatch.uploaded_at.desc())
            )
            if existing_period_batch and enforce_period_check and not allow_period_update:
                stored_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Ya existe una carga para el periodo {detected_period}. "
                        "¿Deseas actualizar el mes reemplazando solo ese periodo y conservando los demás meses?"
                    ),
                )

            if allow_period_update and detected_month_start and detected_next_month_start:
                replaced_result = db.execute(
                    delete(AccountingRecord)
                    .where(AccountingRecord.owner_id == user.id)
                    .where(AccountingRecord.company_id == company.id)
                    .where(AccountingRecord.vault_id == vault.id)
                    .where(AccountingRecord.date >= detected_month_start)
                    .where(AccountingRecord.date < detected_next_month_start)
                )
                replaced_rows += replaced_result.rowcount if replaced_result.rowcount and replaced_result.rowcount > 0 else 0

        existing_rows = db.execute(
            select(
                AccountingRecord.date,
                AccountingRecord.account,
                AccountingRecord.category,
                AccountingRecord.subcategory,
                AccountingRecord.project,
                AccountingRecord.project_code,
                AccountingRecord.description,
                AccountingRecord.flow_type,
                AccountingRecord.amount,
                AccountingRecord.document_number,
            ).where(AccountingRecord.owner_id == user.id)
            .where(AccountingRecord.company_id == company.id)
            .where(AccountingRecord.vault_id == vault.id)
        ).all()
        existing_fingerprints = {
            build_record_fingerprint(
                user.id,
                row_data[0],
                row_data[1] or "General",
                row_data[2] or "",
                row_data[3] or "General",
                row_data[4] or "Sin proyecto",
                row_data[5] or "",
                row_data[6] or "",
                row_data[7] or "",
                float(row_data[8] or 0),
                row_data[9] or "",
            )
            for row_data in existing_rows
        }

        for _, row in dataframe.iterrows():
            try:
                flow_raw = str(row[column_map["tipo"]]).strip().lower()
                flow_type = flow_aliases.get(flow_raw)
                if flow_type not in {"ingreso", "egreso"}:
                    continue

                if "monto" in column_map:
                    amount = parse_amount(row[column_map["monto"]])
                elif flow_type == "ingreso":
                    amount = parse_amount(row[column_map["entrada_neta"]])
                else:
                    amount = parse_amount(row[column_map["salida_neta"]])

                description_column = column_map.get("descripcion")
                subcategory_column = column_map.get("subcategoria")
                project_column = column_map.get("proyecto")
                month_column = column_map.get("mes")
                account_column = column_map.get("cuenta")
                project_code_column = column_map.get("codigo_proyecto")
                counterparty_column = column_map.get("emisor_receptor")
                document_type_column = column_map.get("tipo_documento")
                document_number_column = column_map.get("numero_documento")
                verified_column = column_map.get("verificado")
                comments_column = column_map.get("comentarios")
                balance_column = column_map.get("saldo")

                description = normalize_text_value(row[description_column], "") if description_column else ""
                subcategory = normalize_text_value(row[subcategory_column], "General") if subcategory_column else "General"
                project = normalize_text_value(row[project_column], "Sin proyecto") if project_column else "Sin proyecto"
                account = normalize_text_value(row[account_column], "General") if account_column else "General"
                project_code = normalize_text_value(row[project_code_column], "") if project_code_column else ""
                counterparty = normalize_text_value(row[counterparty_column], "") if counterparty_column else ""
                document_type = normalize_text_value(row[document_type_column], "") if document_type_column else ""
                document_number = normalize_text_value(row[document_number_column], "") if document_number_column else ""
                verified = normalize_text_value(row[verified_column], "") if verified_column else ""
                comments = normalize_text_value(row[comments_column], "") if comments_column else ""

                parsed_date = parse_excel_date(row[column_map["fecha"]])
                month = normalize_text_value(row[month_column], parsed_date.strftime("%Y-%m")) if month_column else parsed_date.strftime("%Y-%m")
                period_samples.append(month)

                balance = parse_amount(row[balance_column]) if balance_column else 0.0

                if not description:
                    description = f"{str(row[column_map['categoria']]).strip()} - {subcategory}"

                source_filename = file.filename
                fingerprint = build_record_fingerprint(
                    user.id,
                    parsed_date,
                    account,
                    str(row[column_map["categoria"]]).strip(),
                    subcategory,
                    project,
                    project_code,
                    description,
                    flow_type,
                    amount,
                    document_number,
                )
                if fingerprint in existing_fingerprints:
                    duplicates += 1
                    continue
                existing_fingerprints.add(fingerprint)

                record = AccountingRecord(
                    owner_id=user.id,
                    company_id=company.id,
                    vault_id=vault.id,
                    upload_batch_id=batch.id,
                    date=parsed_date,
                    month=month,
                    account=account,
                    category=str(row[column_map["categoria"]]).strip(),
                    subcategory=subcategory,
                    project=project,
                    project_code=project_code,
                    counterparty=counterparty,
                    description=description,
                    document_type=document_type,
                    document_number=document_number,
                    flow_type=flow_type,
                    verified=verified,
                    comments=comments,
                    amount=amount,
                    balance=balance,
                    source_filename=source_filename,
                )
            except Exception:
                continue
            db.add(record)
            created += 1

        if period_samples and not batch.period_label:
            non_empty_periods = [item for item in period_samples if item]
            if non_empty_periods:
                batch.period_label = sorted(set(non_empty_periods))[0]

    if not header_found:
        stored_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail="No se detectaron columnas válidas en el Excel. Usa el formato estándar o el formato de flujo de caja con cabecera FECHA/TIPO DE MOVIMIENTO.",
        )

    batch.records_inserted = created
    batch.duplicates_skipped = duplicates
    if not batch.period_label:
        batch.period_label = datetime.now().strftime("%Y-%m")
    if allow_period_update and batch.period_label:
        batch.period_label = f"{batch.period_label} (actualizado)"

    db.commit()
    return {
        "message": "Carga completada",
        "rows_inserted": created,
        "rows_replaced": replaced_rows,
        "duplicates_skipped": duplicates,
        "upload_batch_id": batch.id,
        "stored_file": batch.stored_path,
    }


@app.get("/api/data/uploads")
def uploads_history(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    rows = db.scalars(
        select(UploadBatch)
        .where(UploadBatch.owner_id == user.id)
        .where(UploadBatch.company_id == company.id)
        .where(UploadBatch.vault_id == vault.id)
        .order_by(UploadBatch.uploaded_at.desc())
        .limit(100)
    ).all()
    return [
        {
            "id": item.id,
            "filename": item.original_filename,
            "stored_path": item.stored_path,
            "period": item.period_label,
            "uploaded_at": item.uploaded_at.isoformat(),
            "rows_inserted": item.records_inserted,
            "duplicates_skipped": item.duplicates_skipped,
        }
        for item in rows
    ]


@app.delete("/api/data/clear")
def clear_records(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    category: Optional[str] = Query(default=None),
    subcategory: Optional[str] = Query(default=None),
    project: Optional[str] = Query(default=None),
    account: Optional[str] = Query(default=None),
    project_code: Optional[str] = Query(default=None),
    year: Optional[str] = Query(default=None),
    month_number: Optional[str] = Query(default=None),
    flow_type: Optional[str] = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    statement = delete(AccountingRecord).where(
        AccountingRecord.owner_id == user.id,
        AccountingRecord.company_id == company.id,
        AccountingRecord.vault_id == vault.id,
    )
    statement = apply_record_filters(statement, category, subcategory, project, account, project_code, year, month_number, flow_type, date_from, date_to, search)
    result = db.execute(statement)
    db.commit()
    deleted_rows = result.rowcount if result.rowcount and result.rowcount > 0 else 0
    return {"message": "Datos eliminados", "deleted_rows": deleted_rows}


@app.get("/api/data/records")
def records(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    category: Optional[str] = Query(default=None),
    subcategory: Optional[str] = Query(default=None),
    project: Optional[str] = Query(default=None),
    account: Optional[str] = Query(default=None),
    project_code: Optional[str] = Query(default=None),
    year: Optional[str] = Query(default=None),
    month_number: Optional[str] = Query(default=None),
    flow_type: Optional[str] = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=200, le=1000),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    query = select(AccountingRecord).where(
        AccountingRecord.owner_id == user.id,
        AccountingRecord.company_id == company.id,
        AccountingRecord.vault_id == vault.id,
    )
    query = apply_record_filters(query, category, subcategory, project, account, project_code, year, month_number, flow_type, date_from, date_to, search)

    query = query.order_by(AccountingRecord.date.desc()).limit(limit)
    result = db.scalars(query).all()

    return [
        {
            "id": item.id,
            "mes": item.month,
            "fecha": item.date.isoformat(),
            "cuenta": item.account,
            "categoria": item.category,
            "subcategoria": item.subcategory,
            "proyecto": item.project,
            "codigo_proyecto": item.project_code,
            "emisor_receptor": item.counterparty,
            "descripcion": item.description,
            "tipo_documento": item.document_type,
            "numero_documento": item.document_number,
            "tipo": item.flow_type,
            "verificado": item.verified,
            "comentarios": item.comments,
            "monto": round(item.amount, 2),
            "saldo": round(item.balance, 2),
            "archivo_origen": item.source_filename,
        }
        for item in result
    ]


@app.get("/api/data/records-page")
def records_page(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    category: Optional[str] = Query(default=None),
    subcategory: Optional[str] = Query(default=None),
    project: Optional[str] = Query(default=None),
    account: Optional[str] = Query(default=None),
    project_code: Optional[str] = Query(default=None),
    year: Optional[str] = Query(default=None),
    month_number: Optional[str] = Query(default=None),
    flow_type: Optional[str] = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=100, ge=1, le=1000),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    base_query = select(AccountingRecord).where(
        AccountingRecord.owner_id == user.id,
        AccountingRecord.company_id == company.id,
        AccountingRecord.vault_id == vault.id,
    )
    base_query = apply_record_filters(base_query, category, subcategory, project, account, project_code, year, month_number, flow_type, date_from, date_to, search)

    count_query = apply_record_filters(
        select(func.count()).select_from(AccountingRecord).where(
            AccountingRecord.owner_id == user.id,
            AccountingRecord.company_id == company.id,
            AccountingRecord.vault_id == vault.id,
        ),
        category,
        subcategory,
        project,
        account,
        project_code,
        year,
        month_number,
        flow_type,
        date_from,
        date_to,
        search,
    )
    total = int(db.scalar(count_query) or 0)

    offset = (page - 1) * page_size
    rows = db.scalars(base_query.order_by(AccountingRecord.date.desc()).offset(offset).limit(page_size)).all()

    total_pages = (total + page_size - 1) // page_size if total > 0 else 1

    return {
        "items": [
            {
                "id": item.id,
                "mes": item.month,
                "fecha": item.date.isoformat(),
                "cuenta": item.account,
                "categoria": item.category,
                "subcategoria": item.subcategory,
                "proyecto": item.project,
                "codigo_proyecto": item.project_code,
                "emisor_receptor": item.counterparty,
                "descripcion": item.description,
                "tipo_documento": item.document_type,
                "numero_documento": item.document_number,
                "tipo": item.flow_type,
                "verificado": item.verified,
                "comentarios": item.comments,
                "monto": round(item.amount, 2),
                "saldo": round(item.balance, 2),
                "archivo_origen": item.source_filename,
            }
            for item in rows
        ],
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages,
    }


@app.get("/api/data/summary")
def summary(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    category: Optional[str] = Query(default=None),
    subcategory: Optional[str] = Query(default=None),
    project: Optional[str] = Query(default=None),
    account: Optional[str] = Query(default=None),
    project_code: Optional[str] = Query(default=None),
    year: Optional[str] = Query(default=None),
    month_number: Optional[str] = Query(default=None),
    flow_type: Optional[str] = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    category_query = apply_record_filters(
        select(AccountingRecord.category, func.sum(AccountingRecord.amount))
        .where(
            AccountingRecord.owner_id == user.id,
            AccountingRecord.company_id == company.id,
            AccountingRecord.vault_id == vault.id,
        )
        .group_by(AccountingRecord.category)
        .order_by(func.sum(AccountingRecord.amount).desc()),
        category,
        subcategory,
        project,
        account,
        project_code,
        year,
        month_number,
        flow_type,
        date_from,
        date_to,
        search,
    )
    by_category = db.execute(category_query).all()

    month_query = apply_record_filters(
        select(AccountingRecord.month, func.sum(AccountingRecord.amount))
        .where(
            AccountingRecord.owner_id == user.id,
            AccountingRecord.company_id == company.id,
            AccountingRecord.vault_id == vault.id,
        )
        .group_by(AccountingRecord.month)
        .order_by(AccountingRecord.month),
        category,
        subcategory,
        project,
        account,
        project_code,
        year,
        month_number,
        flow_type,
        date_from,
        date_to,
        search,
    )
    by_month = db.execute(month_query).all()

    flow_query = apply_record_filters(
        select(AccountingRecord.flow_type, func.sum(AccountingRecord.amount))
        .where(
            AccountingRecord.owner_id == user.id,
            AccountingRecord.company_id == company.id,
            AccountingRecord.vault_id == vault.id,
        )
        .group_by(AccountingRecord.flow_type),
        category,
        subcategory,
        project,
        account,
        project_code,
        year,
        month_number,
        flow_type,
        date_from,
        date_to,
        search,
    )
    by_flow = db.execute(flow_query).all()

    return {
        "by_category": [{"label": row[0], "value": float(row[1])} for row in by_category],
        "by_month": [{"label": row[0], "value": float(row[1])} for row in by_month],
        "by_flow": [{"label": row[0], "value": float(row[1])} for row in by_flow],
    }


@app.get("/api/data/categories")
def categories(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    result = db.execute(
        select(AccountingRecord.category)
        .where(
            AccountingRecord.owner_id == user.id,
            AccountingRecord.company_id == company.id,
            AccountingRecord.vault_id == vault.id,
        )
        .group_by(AccountingRecord.category)
        .order_by(AccountingRecord.category.asc())
    ).all()
    return [row[0] for row in result]


@app.get("/api/data/subcategories")
def subcategories(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    category: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    query = select(AccountingRecord.subcategory).where(
        AccountingRecord.owner_id == user.id,
        AccountingRecord.company_id == company.id,
        AccountingRecord.vault_id == vault.id,
    )
    if category:
        query = query.where(AccountingRecord.category == category)
    result = db.execute(query.group_by(AccountingRecord.subcategory).order_by(AccountingRecord.subcategory.asc())).all()
    return [row[0] for row in result if row[0]]


@app.get("/api/data/projects")
def projects(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    category: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    query = select(AccountingRecord.project).where(
        AccountingRecord.owner_id == user.id,
        AccountingRecord.company_id == company.id,
        AccountingRecord.vault_id == vault.id,
    )
    if category:
        query = query.where(AccountingRecord.category == category)
    result = db.execute(query.group_by(AccountingRecord.project).order_by(AccountingRecord.project.asc())).all()
    return [row[0] for row in result if row[0]]


@app.get("/api/data/accounts")
def accounts(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    result = db.execute(
        select(AccountingRecord.account)
        .where(
            AccountingRecord.owner_id == user.id,
            AccountingRecord.company_id == company.id,
            AccountingRecord.vault_id == vault.id,
        )
        .group_by(AccountingRecord.account)
        .order_by(AccountingRecord.account.asc())
    ).all()
    return [row[0] for row in result if row[0]]


@app.get("/api/data/project-codes")
def project_codes(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    result = db.execute(
        select(AccountingRecord.project_code)
        .where(
            AccountingRecord.owner_id == user.id,
            AccountingRecord.company_id == company.id,
            AccountingRecord.vault_id == vault.id,
        )
        .group_by(AccountingRecord.project_code)
        .order_by(AccountingRecord.project_code.asc())
    ).all()
    return [row[0] for row in result if row[0]]


@app.get("/api/data/years")
def years(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    result = db.execute(
        select(extract("year", AccountingRecord.date))
        .where(
            AccountingRecord.owner_id == user.id,
            AccountingRecord.company_id == company.id,
            AccountingRecord.vault_id == vault.id,
        )
        .group_by(extract("year", AccountingRecord.date))
        .order_by(extract("year", AccountingRecord.date).desc())
    ).all()
    return [str(int(row[0])) for row in result if row[0] is not None]


@app.get("/api/data/report")
def detailed_report(
    company_id: Optional[int] = Query(default=None),
    vault_id: Optional[int] = Query(default=None),
    category: Optional[str] = Query(default=None),
    subcategory: Optional[str] = Query(default=None),
    project: Optional[str] = Query(default=None),
    account: Optional[str] = Query(default=None),
    project_code: Optional[str] = Query(default=None),
    year: Optional[str] = Query(default=None),
    month_number: Optional[str] = Query(default=None),
    flow_type: Optional[str] = Query(default=None),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    company = resolve_company(user, db, company_id)
    vault = resolve_vault(user, db, company, vault_id)
    filtered_base = apply_record_filters(
        select(AccountingRecord).where(
            AccountingRecord.owner_id == user.id,
            AccountingRecord.company_id == company.id,
            AccountingRecord.vault_id == vault.id,
        ),
        category,
        subcategory,
        project,
        account,
        project_code,
        year,
        month_number,
        flow_type,
        date_from,
        date_to,
        search,
    )
    records = db.scalars(filtered_base.order_by(AccountingRecord.date.desc())).all()

    income_total = sum(record.amount for record in records if record.flow_type == "ingreso")
    expense_total = sum(record.amount for record in records if record.flow_type == "egreso")
    balance = income_total - expense_total

    by_category_rows = db.execute(
        apply_record_filters(
            select(AccountingRecord.category, func.sum(AccountingRecord.amount))
            .where(
                AccountingRecord.owner_id == user.id,
                AccountingRecord.company_id == company.id,
                AccountingRecord.vault_id == vault.id,
            )
            .group_by(AccountingRecord.category)
            .order_by(func.sum(AccountingRecord.amount).desc()),
            category,
            subcategory,
            project,
            account,
            project_code,
            year,
            month_number,
            flow_type,
            date_from,
            date_to,
            search,
        )
    ).all()

    by_flow_rows = db.execute(
        apply_record_filters(
            select(AccountingRecord.flow_type, func.sum(AccountingRecord.amount))
            .where(
                AccountingRecord.owner_id == user.id,
                AccountingRecord.company_id == company.id,
                AccountingRecord.vault_id == vault.id,
            )
            .group_by(AccountingRecord.flow_type),
            category,
            subcategory,
            project,
            account,
            project_code,
            year,
            month_number,
            flow_type,
            date_from,
            date_to,
            search,
        )
    ).all()

    top_category = by_category_rows[0][0] if by_category_rows else None
    top_category_amount = float(by_category_rows[0][1]) if by_category_rows else 0.0

    insights: list[str] = []
    if balance > 0:
        insights.append("El balance del periodo es positivo, con margen operativo favorable.")
    elif balance < 0:
        insights.append("El balance del periodo es negativo; conviene revisar egresos dominantes.")
    else:
        insights.append("El balance del periodo está equilibrado entre ingresos y egresos.")

    if top_category:
        insights.append(f"La categoría con mayor peso es '{top_category}' por {round(top_category_amount, 2)}.")

    if income_total > 0 and expense_total > 0:
        ratio = expense_total / income_total
        if ratio > 0.9:
            insights.append("La relación egreso/ingreso es alta (>90%), existe riesgo de presión en caja.")
        elif ratio < 0.6:
            insights.append("La relación egreso/ingreso es saludable (<60%), con capacidad de crecimiento.")

    if len(records) == 0:
        insights.append("No hay datos para el filtro actual; amplía rango o criterios para generar conclusiones.")

    return {
        "totals": {
            "records": len(records),
            "income": round(income_total, 2),
            "expense": round(expense_total, 2),
            "balance": round(balance, 2),
        },
        "by_flow": [{"label": row[0], "value": float(row[1])} for row in by_flow_rows],
        "top_categories": [
            {"label": row[0], "value": float(row[1])}
            for row in by_category_rows[:5]
        ],
        "insights": insights,
        "analysis_engine": "deterministic-local",
    }
