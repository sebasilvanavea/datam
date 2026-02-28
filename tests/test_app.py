from io import BytesIO

import pandas as pd
from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_auth_and_data_flow():
    register = client.post(
        "/api/auth/register",
        data={"username": "tester", "full_name": "Test User", "password": "supersecure123"},
    )
    assert register.status_code in (200, 400)

    login = client.post("/api/auth/login", data={"username": "tester", "password": "supersecure123"})
    assert login.status_code == 200

    df = pd.DataFrame(
        [
            {
                "fecha": "2025-01-01",
                "categoria": "Ventas",
                "subcategoria": "Online",
                "descripcion": "Factura A",
                "tipo": "ingreso",
                "monto": 1500,
            },
            {
                "fecha": "2025-01-02",
                "categoria": "Servicios",
                "subcategoria": "Consultoría",
                "descripcion": "Pago proveedor",
                "tipo": "egreso",
                "monto": 500,
            }
        ]
    )
    buffer = BytesIO()
    df.to_excel(buffer, index=False)
    buffer.seek(0)

    upload = client.post(
        "/api/data/upload",
        files={"file": ("test.xlsx", buffer.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert upload.status_code == 200

    records = client.get("/api/data/records")
    assert records.status_code == 200
    assert isinstance(records.json(), list)

    filtered_summary = client.get("/api/data/summary", params={"flow_type": "ingreso"})
    assert filtered_summary.status_code == 200
    payload = filtered_summary.json()
    assert all(item["label"] == "ingreso" for item in payload["by_flow"])
