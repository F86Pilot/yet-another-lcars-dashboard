# Small official Python image
FROM python:3.12-slim

# snmpget (NAS panel)
RUN apt-get update \
 && apt-get install -y --no-install-recommends snmp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python packages first (cached unless requirements.txt changes)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the backend + the LCARS page
COPY app/ .

ENV PORT=8088
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT}
