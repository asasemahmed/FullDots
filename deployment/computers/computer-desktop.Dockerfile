# Build the reviewed browser computer first; it retains the managed coding policies.
ARG COMPUTER_BASE_IMAGE=opendots-computer:b6932d3-acp5
FROM ${COMPUTER_BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      xfce4 xfce4-terminal mousepad dbus-x11 xdotool xclip ffmpeg iproute2 x11-utils util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 --shell /bin/bash desktop \
    && install -d -o desktop -g desktop -m 0700 /profiles/desktop-browser \
    && chmod 0777 /workspace
COPY --from=openbot agent-computer/src /opt/desktop-service/src
RUN ln -s /app/node_modules /opt/desktop-service/node_modules
COPY deployment/computers/desktop /opt/fulldots-desktop
COPY deployment/computers/desktop /opt/desktop-service/src/desktop
RUN node /opt/fulldots-desktop/patch.mjs /opt/desktop-service/src \
    && chmod 0555 /opt/fulldots-desktop/worker.sh
ENV COMPUTER_BROWSER_MODE=headed
CMD ["node", "/opt/fulldots-desktop/gateway.mjs"]
