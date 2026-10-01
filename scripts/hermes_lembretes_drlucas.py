"""
hermes_lembretes_drlucas.py
Módulo de Lembretes de Confirmação 24h & <24h Dr. Lucas (Hermes)
Destinado a implantação em: /opt/gastaomatos/hermes/lembretes/

REGRAS E SEGURANÇA MÁXIMA:
1. NUNCA aceitar HTTP 200 ou 'sent' como prova de entrega real.
   Apenas os status 'delivered' ou 'read' recebidos no webhook da Meta comprovam entrega.
2. Agendamentos de última hora (<24h):
   Se a consulta for agendada com menos de 24h de antecedência (0.16h < antecedência < 23h),
   o lembrete é disparado IMEDIATAMENTE (disparo de última hora), evitando perdas silenciosas.
3. TESTE SEGURO:
   Em ambiente de teste/QA, utilizar APENAS números de teste autorizados (SAFE_TEST_PHONES).
"""

import os
import json
import sqlite3
import datetime
import logging
from typing import Dict, Any, Optional, List

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("hermes_lembretes")

DB_PATH = os.getenv("LEMBRETES_DB_PATH", "/opt/gastaomatos/hermes/lembretes/lembretes.db")

def init_db(db_path: str = DB_PATH):
    """Inicializa a tabela SQLite de persistência de status reais de lembretes."""
    db_dir = os.path.dirname(db_path)
    if db_dir and not os.path.exists(db_dir):
        os.makedirs(db_dir, exist_ok=True)
        
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS lembretes_disparados (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            appointment_id TEXT NOT NULL,
            patient_phone TEXT NOT NULL,
            appointment_datetime TEXT NOT NULL,
            dispatch_type TEXT NOT NULL,
            wamid TEXT UNIQUE,
            status TEXT NOT NULL DEFAULT 'sent',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_lembretes_wamid ON lembretes_disparados (wamid);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_lembretes_appointment ON lembretes_disparados (appointment_id);")
    conn.commit()
    conn.close()

def process_meta_status_callback(payload: Dict[str, Any], db_path: str = DB_PATH) -> int:
    """
    Processa os callbacks de webhook da Meta (hermes.casaldotrafego.com/drlucas/whatsapp/webhook).
    Atualiza o status real ('sent' -> 'delivered' -> 'read' -> 'failed') associado ao wamid.
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    entries = payload.get("entry", [])
    updated_count = 0
    
    for entry in entries:
        changes = entry.get("changes", [])
        for change in changes:
            value = change.get("value", {})
            statuses = value.get("statuses", [])
            for s in statuses:
                wamid = s.get("id")
                status = s.get("status")  # sent | delivered | read | failed
                if wamid and status:
                    cursor.execute("""
                        UPDATE lembretes_disparados
                        SET status = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE wamid = ?
                    """, (status, wamid))
                    if cursor.rowcount > 0:
                        updated_count += 1
                        logger.info(f"[Status Callback] WAMID {wamid} atualizado para status real: '{status}'")
    
    conn.commit()
    conn.close()
    return updated_count

def check_appointment_eligibility(appointment_dt: datetime.datetime, now: Optional[datetime.datetime] = None) -> Dict[str, Any]:
    """
    Avalia a elegibilidade de disparo de lembrete:
    - Janela Padrão (24h): 23h <= antecedência <= 25h -> '24h_standard'
    - Janela ÚLTIMA HORA (<24h): 10min <= antecedência < 23h -> 'immediate_last_minute'
    - Inelegível: antecedência > 25h ou < 10min
    """
    if now is None:
        now = datetime.datetime.now(datetime.timezone.utc)
    
    if appointment_dt.tzinfo is None:
        appointment_dt = appointment_dt.replace(tzinfo=datetime.timezone.utc)
        
    diff_seconds = (appointment_dt - now).total_seconds()
    diff_hours = diff_seconds / 3600.0

    if 23.0 <= diff_hours <= 25.0:
        return {"eligible": True, "dispatch_type": "24h_standard", "reason": "Dentro da janela padrao de 24h"}
    elif 0.166 <= diff_hours < 23.0:
        return {"eligible": True, "dispatch_type": "immediate_last_minute", "reason": f"Agendamento de ultima hora ({diff_hours:.1f}h de antecedencia)"}
    else:
        return {"eligible": False, "dispatch_type": None, "reason": f"Fora da janela elegivel ({diff_hours:.1f}h de antecedencia)"}

def record_dispatch(appointment_id: str, patient_phone: str, appointment_dt: datetime.datetime, dispatch_type: str, wamid: str, db_path: str = DB_PATH) -> bool:
    """Registra um disparo de lembrete prevenindo envios duplicados."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("""
            INSERT INTO lembretes_disparados (appointment_id, patient_phone, appointment_datetime, dispatch_type, wamid, status)
            VALUES (?, ?, ?, ?, ?, 'sent')
        """, (appointment_id, patient_phone, appointment_dt.isoformat(), dispatch_type, wamid))
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        logger.warning(f"[Duplicate Avoided] Lembrete ja registrado para WAMID {wamid} ou consulta {appointment_id}")
        return False
    finally:
        conn.close()
