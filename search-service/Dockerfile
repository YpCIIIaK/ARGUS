FROM docker.io/searxng/searxng:latest

USER root
COPY --chown=977:977 settings.yml /etc/searxng/settings.yml
COPY --chown=977:977 proxy.py /opt/argus-search/proxy.py
COPY --chmod=755 start.sh /opt/argus-search/start.sh

ENTRYPOINT ["/opt/argus-search/start.sh"]
