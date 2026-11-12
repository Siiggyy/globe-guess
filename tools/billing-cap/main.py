"""Cloud Run function: switches off billing for the project once the budget is exceeded."""
import base64
import json
import os

import functions_framework
from google.cloud import billing_v1

PROJECT_ID = os.environ["PROJECT_ID"]
client = billing_v1.CloudBillingClient()


@functions_framework.cloud_event
def stop_billing(cloud_event):
    data = json.loads(base64.b64decode(cloud_event.data["message"]["data"]).decode())
    cost, budget = float(data["costAmount"]), float(data["budgetAmount"])
    if cost <= budget:
        print(f"Cost {cost} is within budget {budget}, nothing to do.")
        return

    name = f"projects/{PROJECT_ID}"
    if not client.get_project_billing_info(name=name).billing_enabled:
        print("Billing already disabled.")
        return

    client.update_project_billing_info(
        name=name,
        project_billing_info=billing_v1.ProjectBillingInfo(billing_account_name=""),
    )
    print(f"Cost {cost} exceeded budget {budget}: billing DISABLED for {PROJECT_ID}.")
